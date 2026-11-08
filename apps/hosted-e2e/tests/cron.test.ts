import { expect } from "vitest";
import { ACTIVE_TURN_STATUSES } from "@onecli/api/validations/conversation";
import { scenario } from "../src/scenario.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import { containerNameFor, dockerExec } from "../src/docker.js";
import { fakeDirective, sleep, text } from "../src/fake-dsl.js";
import { fetchTranscript, transcriptText, waitFor } from "../src/v1.js";

/**
 * The schedule leg (step 7 through step 13's lens): a cron created over REST
 * force-fires through the REAL poll path (`POST /:cronId/run` only pulls
 * `nextFireAt` to now — the runner's next poll does the firing), runs in its
 * own cron-sourced conversation, and delivers the report to the creator's
 * direct thread.
 */

scenario(
  "a cron fires through the poll and reports to the origin thread",
  async (cx) => {
    const stack = await cx.startStack();
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
    });
    await seedAnthropicGrant(cx.prisma, cx.ids);
    stack.runner.pump();

    // The origin: the creator's direct thread (the cron door resolves it).
    const direct = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );

    const cron = await stack.v1.json<{ id: string }>(
      await stack.v1.post(`/v1/agents/${cx.ids.agent}/crons`, {
        name: "nightly probe",
        prompt: "report the weather in the sandbox",
        schedule: "0 3 * * *",
        timezone: "UTC",
      }),
    );

    const fired = await stack.v1.post(
      `/v1/agents/${cx.ids.agent}/crons/${cron.id}/run`,
    );
    expect(fired.ok).toBe(true);

    // The run lands in its OWN cron-sourced conversation…
    const cronConversation = await waitFor(
      () =>
        cx.prisma.conversation.findFirst({
          where: { agentId: cx.ids.agent, source: "cron" },
        }),
      (conversation) => conversation !== null,
      "the cron-sourced conversation",
    );
    await waitFor(
      () =>
        cx.prisma.turn.findFirst({
          where: { conversationId: cronConversation?.id ?? "", status: "done" },
        }),
      (turn) => turn !== null,
      "the cron run to complete",
    );

    // …and the report is DELIVERED to the origin thread.
    await waitFor(
      async () => transcriptText(await fetchTranscript(stack.v1, direct.id)),
      (text) => text.includes("report the weather"),
      "the cron report to reach the direct thread",
    );

    await stack.runner.pausePump();
  },
);

scenario(
  "a one-shot schedule fires once, completes, and is never re-claimed",
  async (cx) => {
    const stack = await cx.startStack();
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
    });
    await seedAnthropicGrant(cx.prisma, cx.ids);
    stack.runner.pump();

    const direct = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );

    // croner's fire-once pattern: an ISO local datetime, read in the given
    // timezone. Near-future with real slack: creation validates against NOW,
    // so a loaded CI box must not push the datetime into the past before the
    // create lands (a 422 there, not a flaky waitFor). The real poll then
    // claims and fires it within seconds of dueness.
    const onceAt = new Date(Date.now() + 10_000).toISOString().slice(0, 19);
    const cron = await stack.v1.json<{ id: string }>(
      await stack.v1.post(`/v1/agents/${cx.ids.agent}/crons`, {
        name: "one-shot probe",
        prompt: "report the one-shot marker",
        schedule: onceAt,
        timezone: "UTC",
      }),
    );

    // Fired by the REAL poll at its due time — no force-fire needed.
    const cronConversation = await waitFor(
      () =>
        cx.prisma.conversation.findFirst({
          where: { agentId: cx.ids.agent, source: "cron" },
        }),
      (conversation) => conversation !== null,
      "the one-shot's cron-sourced conversation",
    );
    await waitFor(
      () =>
        cx.prisma.turn.findFirst({
          where: { conversationId: cronConversation?.id ?? "", status: "done" },
        }),
      (turn) => turn !== null,
      "the one-shot run to complete",
    );

    // The row is terminal by DESIGN — completed, not failed, not re-armed…
    const row = await waitFor(
      () => cx.prisma.agentCron.findUniqueOrThrow({ where: { id: cron.id } }),
      (cron) => !cron.enabled,
      "the schedule to complete",
    );
    expect(row.disabledReason).toBe("completed");
    expect(row.lastFiredAt).not.toBeNull();

    // …the report reaches the origin thread…
    await waitFor(
      async () => transcriptText(await fetchTranscript(stack.v1, direct.id)),
      (text) => text.includes("one-shot marker"),
      "the one-shot report to reach the direct thread",
    );

    // …and further polls never fire it again (the forever-reclaim bug pin:
    // pre-fix, the spent row was re-claimed every poll, forever).
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    expect(
      await cx.prisma.turn.count({
        where: { conversationId: cronConversation?.id ?? "" },
      }),
    ).toBe(1);

    await stack.runner.pausePump();
  },
);

scenario(
  "a gated schedule: quiet runs no model, a wake delivers, a person's stop reads stopped",
  async (cx) => {
    const stack = await cx.startStack();
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
    });
    await seedAnthropicGrant(cx.prisma, cx.ids);
    stack.runner.pump();

    const direct = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    const crons = `/v1/agents/${cx.ids.agent}/crons`;
    const view = async (cronId: string) =>
      (
        await stack.v1.json<{ crons: CronView[] }>(await stack.v1.get(crons))
      ).crons.find((cron) => cron.id === cronId);
    const runs = (conversationId: string) =>
      cx.prisma.turn.findMany({
        where: { conversationId },
        orderBy: { createdAt: "asc" },
      });
    // Settled = out of every active status, `dispatched` included: a gated
    // run sits there while its check runs, before the supervisor starts it.
    const isSettled = (status: string) =>
      !ACTIVE_TURN_STATUSES.some((active) => active === status);
    const fireAndSettle = async (cronId: string, count: number) => {
      expect((await stack.v1.post(`${crons}/${cronId}/run`)).ok).toBe(true);
      const conversation = await waitFor(
        () =>
          cx.prisma.conversation.findFirst({
            where: { source: "cron", externalRef: cronId },
          }),
        (found) => found !== null,
        "the schedule's conversation",
      );
      const settled = await waitFor(
        () => runs(conversation!.id),
        (turns) => turns.length === count && isSettled(turns.at(-1)!.status),
        `run ${count} to settle`,
      );
      return { conversationId: conversation!.id, run: settled.at(-1)! };
    };

    // A check and its plain words go together, or not at all.
    const unpaired = await stack.v1.post(crons, {
      name: "deck watcher",
      prompt: "report",
      schedule: "0 3 * * *",
      timezone: "UTC",
      gate: "echo hi",
    });
    expect(unpaired.status).toBe(422);

    // The check's LAST line decides: a log line above `{"wakeAgent": false}`
    // is still quiet. A marker file is how the test flips it to a wake.
    const marker = "/tmp/e2e-gate-wake";
    const cron = await stack.v1.json<{ id: string }>(
      await stack.v1.post(crons, {
        name: "deck watcher",
        prompt: fakeDirective([text("DECK REPORT")]),
        schedule: "0 3 * * *",
        timezone: "UTC",
        gate: `echo checking; if [ -f ${marker} ]; then echo "new deck: q3.pdf"; else echo '{"wakeAgent": false}'; fi`,
        gateDescription: "a new board deck appears",
      }),
    );

    // 1. Quiet: the run settles ok as [no reply], with no model turn and
    //    nothing delivered to the person.
    const quiet = await fireAndSettle(cron.id, 1);
    expect(quiet.run.status).toBe("done");
    const quietText = transcriptText(
      await fetchTranscript(stack.v1, quiet.conversationId),
    );
    expect(quietText).toBe("[no reply]");
    expect(await view(cron.id)).toMatchObject({
      lastOutcome: "ok",
      running: false,
    });

    // 2. Wake: the agent runs with the check's output fenced as untrusted
    //    data, and its report reaches the person.
    await dockerExec(containerNameFor(cx.ids.sandbox), ["touch", marker]);
    const woke = await fireAndSettle(cron.id, 2);
    expect(woke.run.status).toBe("done");
    expect(woke.run.message).not.toContain("new deck"); // stored prompt only
    await waitFor(
      async () => transcriptText(await fetchTranscript(stack.v1, direct.id)),
      (text) => text.includes("DECK REPORT"),
      "the woken run's report to reach the person",
    );

    // 3. A person stops a live run: it reads stopped, not failed, and counts
    //    no strike; while it ran, the schedule read running.
    const slow = await stack.v1.json<{ id: string }>(
      await stack.v1.post(crons, {
        name: "slow report",
        prompt: fakeDirective([sleep(60_000), text("never says this")]),
        schedule: "0 4 * * *",
        timezone: "UTC",
      }),
    );
    expect((await stack.v1.post(`${crons}/${slow.id}/run`)).ok).toBe(true);
    const live = await waitFor(
      () =>
        cx.prisma.turn.findFirst({
          where: {
            conversation: { source: "cron", externalRef: slow.id },
            status: "running",
          },
        }),
      (turn) => turn !== null,
      "the slow run to start",
    );
    expect(await view(slow.id)).toMatchObject({ running: true });
    expect((await stack.v1.post(`/v1/turns/${live!.id}/abort`)).ok).toBe(true);
    const stopped = await waitFor(
      () => view(slow.id),
      (found) => found?.lastOutcome === "stopped" && !found.running,
      "the stopped run to read stopped",
    );
    expect(stopped?.consecutiveFailures).toBe(0);

    await stack.runner.pausePump();
  },
);

interface CronView {
  id: string;
  lastOutcome: string | null;
  running: boolean;
  consecutiveFailures: number;
}
