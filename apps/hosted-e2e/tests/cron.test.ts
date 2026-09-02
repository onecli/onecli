import { expect } from "vitest";
import { scenario } from "../src/scenario.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
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
