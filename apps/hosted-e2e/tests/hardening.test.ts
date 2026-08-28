import { expect } from "vitest";
import { scenario } from "../src/scenario.js";
import { containerNameFor, dockerKill } from "../src/docker.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import { fakeDirective, sleep, text } from "../src/fake-dsl.js";
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
 * mid-turn surfaces the honest #834 copy and the NEXT message recovers; a
 * runner restart (new process, same token → same Runner row) reconciles the
 * stranded box back into the wake path.
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
  "a container killed mid-turn: honest copy, then recovery",
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
    await waitFor(
      () => readTurn(stack.v1, conversation.id, created.id),
      (turn) => turn?.status === "running",
      "the doomed turn to start",
    );

    await dockerKill(containerNameFor(cx.ids.sandbox));

    // A SIGKILL'd container reports nothing — RECONCILE is the detection path
    // (the #834 dead-but-expected arm; 60s cadence in production, driven by
    // hand here). The strand law then fails the running turn with the honest
    // restart copy, never a silent hang to the ceiling.
    const failed = await waitFor(
      async () => {
        await stack.runner?.reconcile();
        return readTurn(stack.v1, conversation.id, created.id);
      },
      (turn) => turn?.status === "failed",
      "the killed turn to fail honestly",
      90_000,
    );
    expect(failed?.errorCode).toBe("agent_restarted");

    // And the very next message recovers on a fresh container.
    const recovered = await runTurn(stack.v1, conversation.id, "you back?");
    expect(recovered.status).toBe("done");

    await stack.runner.pausePump();
  },
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
    // is now running-but-channelless (its single-use ws token died with the
    // old process); reconcile reports it stopped, the wake path recreates.
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
