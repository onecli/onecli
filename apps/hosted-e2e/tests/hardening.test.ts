import type { RunnerEvent } from "@onecli/agent-protocol";
import {
  AGENT_RESUMING_NOTICE,
  RESUMED_TURN_CONTEXT,
} from "@onecli/api/validations/conversation";
import { expect } from "vitest";
import { scenario } from "../src/scenario.js";
import { containerNameFor, dockerKill, isRunning } from "../src/docker.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import { fakeDirective, prompt, sleep, state, text } from "../src/fake-dsl.js";
import { startTestRunner } from "../src/runner.js";
import {
  fetchTranscript,
  readTurn,
  runTurn,
  transcriptText,
  waitFor,
} from "../src/v1.js";

/**
 * Abuse & multi-tenant hardening — the legs the deleted `run-hardening.sh`
 * held: two tenants sharing one runner never bleed; a container killed
 * mid-turn resumes the turn on a fresh container in its own session (and a
 * second kill surfaces the honest restart copy, after which the NEXT message
 * recovers); a runner restart (new process, same token → same Runner row)
 * reconciles the stranded box back into the wake path.
 */

scenario("two tenants, one runner: transcripts never bleed", async (cx) => {
  const stack = await cx.startStack();
  if (stack.runner === null) throw new Error("runner expected");
  await seedTenant(cx.prisma, cx.ids, "first");
  await seedTenant(cx.prisma, cx.ids, "second");
  await seedHostedAgent(cx.prisma, cx.ids, {
    runnerId: stack.runner.runnerId,
    which: "first",
  });
  await seedHostedAgent(cx.prisma, cx.ids, {
    runnerId: stack.runner.runnerId,
    which: "second",
  });
  await seedAnthropicGrant(cx.prisma, cx.ids, { which: "first" });
  await seedAnthropicGrant(cx.prisma, cx.ids, { which: "second" });
  stack.runner.pump();

  const v1B = cx.v1For(stack.api.origin, "second");
  const conversationA = await stack.v1.json<{ id: string }>(
    await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
  );
  const conversationB = await v1B.json<{ id: string }>(
    await v1B.put(`/v1/agents/${cx.ids.secondAgent}/conversations/direct`),
  );

  const [turnA, turnB] = await Promise.all([
    runTurn(stack.v1, conversationA.id, "tenant A's secret plan"),
    runTurn(v1B, conversationB.id, "tenant B's other plan"),
  ]);
  expect(turnA.status).toBe("done");
  expect(turnB.status).toBe("done");

  const transcriptA = transcriptText(
    await fetchTranscript(stack.v1, conversationA.id),
  );
  const transcriptB = transcriptText(
    await fetchTranscript(v1B, conversationB.id),
  );
  expect(transcriptA).toContain("tenant A's secret plan");
  expect(transcriptA).not.toContain("tenant B's other plan");
  expect(transcriptB).toContain("tenant B's other plan");
  expect(transcriptB).not.toContain("tenant A's secret plan");

  // The workspace fence on the API side: tenant B cannot read A's thread.
  const crossRead = await v1B.get(
    `/v1/conversations/${conversationA.id}/events`,
  );
  expect(crossRead.status).toBeGreaterThanOrEqual(400);

  await stack.runner.pausePump();
});

scenario(
  "a container killed mid-turn: the turn resumes on a fresh container, in its own session, framed as a resume",
  async (cx) => {
    const stack = await cx.startStack();
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
    });
    await seedAnthropicGrant(cx.prisma, cx.ids);
    stack.runner.pump();

    const conversation = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    // The conversation's FIRST turn: no terminal report has ever persisted a
    // session ref, so only the running turn's heartbeat can leave one behind.
    const created = await stack.v1.json<{ id: string }>(
      await stack.v1.post(`/v1/conversations/${conversation.id}/turns`, {
        message: fakeDirective([state(), prompt(), sleep(8_000), text("done")]),
      }),
    );
    await waitFor(
      () => readTurn(stack.v1, conversation.id, created.id),
      (turn) => turn?.status === "running",
      "the turn to start",
    );
    // The first beat (right behind turn.started) carried the session.
    const before = await waitFor(
      () =>
        cx.prisma.conversation.findUniqueOrThrow({
          where: { id: conversation.id },
          select: { harnessSessionRef: true },
        }),
      (row) => row.harnessSessionRef !== null,
      "the heartbeat to persist the running session",
    );

    await dockerKill(containerNameFor(cx.ids.sandbox));

    // A SIGKILL'd container reports nothing: RECONCILE is the detection path
    // (60s cadence in production, driven by hand here). The turn goes back
    // to the queue instead of failing, and a fresh container runs it again.
    const finished = await waitFor(
      async () => {
        await stack.runner?.reconcile();
        return readTurn(stack.v1, conversation.id, created.id);
      },
      (turn) => turn?.status === "done" || turn?.status === "failed",
      "the resumed turn to finish",
      120_000,
    );
    expect(finished?.status).toBe("done");
    expect(finished?.errorCode ?? null).toBeNull();

    const events = await fetchTranscript(stack.v1, conversation.id);
    const transcript = transcriptText(events);
    // The answer the transcript keeps is the run that finished: the resumed
    // one. It ran in the same session as before the kill, on its second run
    // in it, and its prompt opened with the resume frame (the fake echoes
    // the prompt's first line), never the caller's message as a new one.
    expect(transcript).toContain(
      `[state sessionRef=${before.harnessSessionRef} turnsRun=2]`,
    );
    expect(transcript).toContain(
      `[prompt ${RESUMED_TURN_CONTEXT.slice(0, 60)}`,
    );
    // The person sees the one resume line, under the turn.
    expect(
      events.filter(
        (event) =>
          event.type === "notice" &&
          event.turnId === created.id &&
          event.payload["text"] === AGENT_RESUMING_NOTICE,
      ),
    ).toHaveLength(1);

    await stack.runner.pausePump();
  },
);

scenario(
  "a container killed twice mid-turn: one resume, then the honest restart copy, then recovery",
  async (cx) => {
    const stack = await cx.startStack();
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
    });
    await seedAnthropicGrant(cx.prisma, cx.ids);
    stack.runner.pump();

    const conversation = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    const created = await stack.v1.json<{ id: string }>(
      await stack.v1.post(`/v1/conversations/${conversation.id}/turns`, {
        message: fakeDirective([sleep(25_000), text("never delivered")]),
      }),
    );
    // Each wait drives reconcile: a SIGKILL'd container reports nothing, and
    // reconcile is what reports it (and so what re-queues the turn and boots
    // the fresh container its resumed run lands on).
    const killWhileRunning = async (label: string) => {
      await waitFor(
        async () => {
          await stack.runner?.reconcile();
          return readTurn(stack.v1, conversation.id, created.id);
        },
        (turn) => turn?.status === "running",
        label,
        90_000,
      );
      await dockerKill(containerNameFor(cx.ids.sandbox));
    };

    await killWhileRunning("the first run to start");
    await killWhileRunning("the resumed run to start");
    const failed = await waitFor(
      async () => {
        await stack.runner?.reconcile();
        return readTurn(stack.v1, conversation.id, created.id);
      },
      (turn) => turn?.status === "failed",
      "the second death to fail the turn honestly",
      90_000,
    );
    expect(failed?.errorCode).toBe("agent_restarted");

    // And the very next message recovers on a fresh container.
    const recovered = await runTurn(stack.v1, conversation.id, "you back?");
    expect(recovered.status).toBe("done");

    await stack.runner.pausePump();
  },
  300_000,
);

scenario(
  "a runner restart reconciles a stranded box back to life",
  async (cx) => {
    const stack = await cx.startStack();
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
    });
    await seedAnthropicGrant(cx.prisma, cx.ids);
    stack.runner.pump();

    const conversation = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    const first = await runTurn(
      stack.v1,
      conversation.id,
      "before the restart",
    );
    expect(first.status).toBe("done");

    // The restart: stop the loop (sandboxes stay running — production
    // semantics), then a NEW runner process on the SAME token. The container
    // is now running-but-channelless (a keyless runner hands no session, and
    // its bootstrap token was spent on the first connect); reconcile reports
    // it stopped, the wake path recreates.
    await stack.runner.stop();
    const revived = await startTestRunner({
      controlPlaneUrl: stack.api.origin,
      ids: cx.ids,
      config: cx.config,
    });
    expect(revived.runnerId).toBe(stack.runner.runnerId); // same Runner row
    await revived.reconcile();
    revived.pump();

    const after = await runTurn(stack.v1, conversation.id, "after the restart");
    expect(after.status).toBe("done");

    await revived.stop();
    await revived.reap();
  },
);

scenario(
  "a runner restart in the MIDDLE of a turn resumes that turn on the recreated box",
  async (cx) => {
    const stack = await cx.startStack();
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
    });
    await seedAnthropicGrant(cx.prisma, cx.ids);
    stack.runner.pump();

    const conversation = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    const created = await stack.v1.json<{ id: string }>(
      await stack.v1.post(`/v1/conversations/${conversation.id}/turns`, {
        message: fakeDirective([state(), sleep(8_000), text("done")]),
      }),
    );
    await waitFor(
      () => readTurn(stack.v1, conversation.id, created.id),
      (turn) => turn?.status === "running",
      "the turn to start",
    );

    // A runner deploy: the new process cannot reach the old box (its
    // bootstrap token was spent), reconcile reports it stopped, and the
    // in-flight turn rides that death report back into the queue.
    await stack.runner.stop();
    const revived = await startTestRunner({
      controlPlaneUrl: stack.api.origin,
      ids: cx.ids,
      config: cx.config,
    });
    await revived.reconcile();
    revived.pump();

    const finished = await waitFor(
      async () => {
        await revived.reconcile();
        return readTurn(stack.v1, conversation.id, created.id);
      },
      (turn) => turn?.status === "done" || turn?.status === "failed",
      "the resumed turn to finish",
      90_000,
    );
    expect(finished?.status).toBe("done");
    expect(
      transcriptText(await fetchTranscript(stack.v1, conversation.id)),
    ).toMatch(/\[state sessionRef=\S+ turnsRun=2\]/);

    await revived.stop();
    await revived.reap();
  },
);

scenario(
  "a box nothing will wake is STOPPED by the runner, not reported forever (the zombie backstop)",
  async (cx) => {
    // The shape a supervisor that gave up but never exited leaves behind:
    // its container runs on with no channel. The runner's report moves the
    // row to `stopped` once; every later report is a no-op against that row,
    // and nothing recreates a box no message arrives for. Same shape here,
    // on real Docker: a runner restart strands a channelless container, the
    // first reconcile parks its row, and NO message follows. The next pass
    // must stop the container itself.
    const stack = await cx.startStack();
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
    });
    await seedAnthropicGrant(cx.prisma, cx.ids);
    stack.runner.pump();
    const conversation = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    expect((await runTurn(stack.v1, conversation.id, "before")).status).toBe(
      "done",
    );
    await stack.runner.stop();
    const container = containerNameFor(cx.ids.sandbox);

    const revived = await startTestRunner({
      controlPlaneUrl: stack.api.origin,
      ids: cx.ids,
      config: cx.config,
    });
    // start()'s own reconcile: running, channelless, row `running` → the
    // ordinary report, which parks the row. The container is still up.
    await waitFor(
      () => cx.prisma.sandbox.findUnique({ where: { id: cx.ids.sandbox } }),
      (row) => row?.status === "stopped",
      "the report to park the row",
    );
    expect(await isRunning(container)).toBe(true);

    // The next pass finds the same container, row parked: it claims the
    // stop (the row moves to `stopping` under this copy, so no start can
    // race it) and stops it.
    await revived.reconcile();
    await waitFor(
      () => isRunning(container),
      (running) => !running,
      "the runner to stop the stray container",
    );
    // Two reports about that one container, each naming it: the
    // channelless one that parked the row, then the stop's own, which lands
    // the claimed `stopping` back on `stopped` (without it the row would sit
    // in `stopping` until the stale-claim window).
    const reports = revived.posted.filter(
      (e): e is Extract<RunnerEvent, { kind: "sandbox.status" }> =>
        e.kind === "sandbox.status" &&
        e.sandboxId === cx.ids.sandbox &&
        e.status === "stopped",
    );
    expect(reports).toHaveLength(2);
    expect(reports[0]?.observedContainerRef).toBeDefined();
    expect(reports[1]?.observedContainerRef).toBe(
      reports[0]?.observedContainerRef,
    );
    await waitFor(
      () => cx.prisma.sandbox.findUnique({ where: { id: cx.ids.sandbox } }),
      (row) => row?.status === "stopped",
      "the stop to land the row on stopped",
    );

    // And the agent is fine: the next message wakes it as usual.
    revived.pump();
    const after = await runTurn(stack.v1, conversation.id, "after");
    expect(after.status).toBe("done");

    await revived.stop();
    await revived.reap();
  },
);
