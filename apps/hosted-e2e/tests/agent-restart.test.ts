import { expect } from "vitest";
import { scenario } from "../src/scenario.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import { fakeDirective, sleep, state, text } from "../src/fake-dsl.js";
import {
  fetchTranscript,
  readTurn,
  runTurn,
  transcriptText,
  waitFor,
} from "../src/v1.js";

/**
 * "Restart agent", end to end: a person restarts a BUSY agent and the next
 * message lands on a brand-new sandbox with a brand-new harness session.
 *
 * Every piece is real except the model: the api-server child serves the
 * route and the dispatch seam, the in-process runner stops and recreates a
 * real Docker sandbox, and the fake harness persists sessions on the home
 * volume the way jcode does, so `[state sessionRef=… turnsRun=…]` is the
 * session witness. Without the restart, the next turn would resume
 * (`turnsRun=2` on the same ref: the sleep-wake scenario's proof).
 */

const STATE_LINE = /\[state sessionRef=(\S+) turnsRun=(\d+)\]/g;

const lastState = (transcript: string) => {
  const matches = [...transcript.matchAll(STATE_LINE)];
  const last = matches.at(-1);
  if (!last) throw new Error(`no state line in: ${transcript.slice(-500)}`);
  return { sessionRef: last[1], turnsRun: Number(last[2]) };
};

scenario(
  "restart ends the busy agent and the next message starts it fresh",
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

    // A first turn establishes the session the restart must discard.
    const first = await runTurn(
      stack.v1,
      conversation.id,
      fakeDirective([state()]),
    );
    expect(first.status).toBe("done");
    const before = lastState(
      transcriptText(await fetchTranscript(stack.v1, conversation.id)),
    );
    expect(before.turnsRun).toBe(1);
    const containerBefore = stack.runner.containerRefOf(cx.ids.sandbox);
    expect(containerBefore).toBeTruthy();

    // The agent is BUSY when the person restarts it: a long run in flight.
    const busy = await stack.v1.json<{ id: string }>(
      await stack.v1.post(`/v1/conversations/${conversation.id}/turns`, {
        message: fakeDirective([sleep(60_000), text("never says this")]),
      }),
    );
    await waitFor(
      () => readTurn(stack.v1, conversation.id, busy.id),
      (turn) => turn?.status === "running",
      "the long turn to start",
    );

    const restart = await stack.v1.post(
      `/v1/agents/${cx.ids.agent}/restart`,
      {},
    );
    expect(restart.status).toBe(200);

    // The busy turn ends at once with the restart copy, not after its minute.
    const ended = await readTurn(stack.v1, conversation.id, busy.id);
    expect(ended?.status).toBe("failed");
    expect(ended?.errorCode).toBe("agent_restarted");

    // The box is stopped promptly, ahead of the idle window.
    await waitFor(
      () => cx.prisma.sandbox.findUnique({ where: { id: cx.ids.sandbox } }),
      (sandbox) => sandbox?.status === "stopped",
      "the restarted sandbox to stop",
    );

    // The next message cold-starts a NEW container with a NEW session.
    const after = await runTurn(
      stack.v1,
      conversation.id,
      fakeDirective([state()]),
    );
    expect(after.status).toBe("done");
    const fresh = lastState(
      transcriptText(await fetchTranscript(stack.v1, conversation.id)),
    );
    expect(fresh.turnsRun).toBe(1);
    expect(fresh.sessionRef).not.toBe(before.sessionRef);
    const containerAfter = stack.runner.containerRefOf(cx.ids.sandbox);
    expect(containerAfter).toBeTruthy();
    expect(containerAfter).not.toBe(containerBefore);

    // And the fresh boot resumes ITS session on the next turn: the restart
    // flag is gone, so its session ref was kept.
    const again = await runTurn(
      stack.v1,
      conversation.id,
      fakeDirective([state()]),
    );
    expect(again.status).toBe("done");
    const resumed = lastState(
      transcriptText(await fetchTranscript(stack.v1, conversation.id)),
    );
    expect(resumed).toEqual({ sessionRef: fresh.sessionRef, turnsRun: 2 });

    // The audit trail names the restart.
    const audit = await cx.prisma.auditLog.findMany({
      where: { action: "restart", service: "agent" },
    });
    expect(audit).toHaveLength(1);

    await stack.runner.pausePump();
  },
);
