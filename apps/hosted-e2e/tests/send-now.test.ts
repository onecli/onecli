import { expect } from "vitest";
import { scenario, type Cx } from "../src/scenario.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import {
  bash,
  fakeDirective,
  sleep,
  text,
  type FakeStep,
} from "../src/fake-dsl.js";
import {
  fetchTranscript,
  openStream,
  readTurn,
  waitFor,
  type StreamTap,
  type TranscriptEvent,
} from "../src/v1.js";

/**
 * SEND NOW, end to end: a message sent while the agent sits
 * inside a long tool waits for that tool, unless the person asks for it to
 * be read now. Through the real doors: the public message door, the public
 * `POST /v1/turns/:id/send-now`, the runner's claim (delivery first, then
 * the request), the supervisor, and the fake harness's `bash` step, which
 * stands for a long command and is cut short exactly the way jcode moves a
 * tool to the background. The answer, `message.sent_now`, is read off the
 * public stream under the FOLLOW-UP's own id, and the follow-up joins long
 * before the tool would have ended.
 */

/** Seed a talkable agent, start a turn with `steps`, and wait until it is
 * genuinely running, with a live tail open. */
const startLongTurn = async (cx: Cx, steps: FakeStep[]) => {
  const stack = await cx.startStack();
  const runner = stack.runner;
  if (runner === null) throw new Error("runner expected");
  await seedTenant(cx.prisma, cx.ids);
  await seedHostedAgent(cx.prisma, cx.ids, { runnerId: runner.runnerId });
  await seedAnthropicGrant(cx.prisma, cx.ids);
  runner.pump();

  const conversation = await stack.v1.json<{ id: string }>(
    await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
  );
  const tap: StreamTap = await openStream(
    stack.api.origin,
    cx.ids.apiKey,
    cx.ids.workspace,
    conversation.id,
  );
  const created = await stack.v1.json<{ id: string }>(
    await stack.v1.post(`/v1/conversations/${conversation.id}/turns`, {
      message: fakeDirective(steps),
    }),
  );
  await waitFor(
    () => readTurn(stack.v1, conversation.id, created.id),
    (turn) => turn?.status === "running",
    "the long turn to start",
  );
  return {
    stack,
    runner,
    tap,
    conversationId: conversation.id,
    turnId: created.id,
  };
};

const sentNowOf = (tap: StreamTap, followUpId: string) =>
  tap.frames
    .map((frame) => frame.data)
    .find(
      (event: TranscriptEvent) =>
        event.turnId === followUpId && event.type === "message.sent_now",
    );

scenario(
  "SEND NOW moves the running tool and the message is read right away",
  async (cx) => {
    const { stack, runner, tap, conversationId, turnId } = await startLongTurn(
      cx,
      [bash(60_000), text("build finished")],
    );
    await tap.waitForFrame(
      (frame) =>
        frame.data.turnId === turnId && frame.data.type === "tool.started",
      "the long tool to start",
    );

    const followUp = await stack.v1.json<{ turn: { id: string } }>(
      await stack.v1.post(`/v1/conversations/${conversationId}/messages`, {
        message: "stop and check prod",
      }),
    );
    // Asked straight away: the request waits for the delivery on its own.
    const askedAt = Date.now();
    const asked = await stack.v1.post(`/v1/turns/${followUp.turn.id}/send-now`);
    expect(asked.status).toBe(202);
    expect(await asked.json()).toEqual({ requested: true });

    await tap.waitForFrame(
      (frame) =>
        frame.data.turnId === followUp.turn.id &&
        frame.data.type === "message.sent_now",
      "the agent's answer to SEND NOW",
      30_000,
    );
    expect(sentNowOf(tap, followUp.turn.id)?.payload).toEqual({
      type: "message.sent_now",
      moved: true,
      toolName: "bash",
    });

    // Read well before the 60 s tool would have ended.
    await waitFor(
      () => readTurn(stack.v1, conversationId, followUp.turn.id),
      (row) => row?.status === "joined",
      "the follow-up to be read",
      30_000,
    );
    expect(Date.now() - askedAt).toBeLessThan(30_000);

    // Read: a second request is an honest 409, never a second move.
    const again = await stack.v1.post(`/v1/turns/${followUp.turn.id}/send-now`);
    expect(again.status).toBe(409);

    await waitFor(
      () => readTurn(stack.v1, conversationId, turnId),
      (turn) => turn !== null && ["done", "failed"].includes(turn.status),
      "the turn to settle",
      60_000,
    );
    expect((await readTurn(stack.v1, conversationId, turnId))?.status).toBe(
      "done",
    );
    // The answer is live-only: never stored under the follow-up.
    const stored = await fetchTranscript(stack.v1, conversationId);
    expect(stored.some((e) => e.type === "message.sent_now")).toBe(false);
    await tap.close();
    await runner.pausePump();
  },
);

scenario(
  "SEND NOW with no tool running says so, and the message is read at the next step",
  async (cx) => {
    const { stack, runner, tap, conversationId, turnId } = await startLongTurn(
      cx,
      // "The next step" is after the sleep; 6 s is about 3x the measured
      // delivery latency, enough runway for the answer to land in it.
      [text("thinking out loud"), sleep(6_000), text("done thinking")],
    );
    await tap.waitForFrame(
      (frame) =>
        frame.data.turnId === turnId && frame.data.type === "text.delta",
      "the turn to start talking",
    );
    const followUp = await stack.v1.json<{ turn: { id: string } }>(
      await stack.v1.post(`/v1/conversations/${conversationId}/messages`, {
        message: "and one more thing",
      }),
    );
    const asked = await stack.v1.post(`/v1/turns/${followUp.turn.id}/send-now`);
    expect(asked.status).toBe(202);

    await tap.waitForFrame(
      (frame) =>
        frame.data.turnId === followUp.turn.id &&
        frame.data.type === "message.sent_now",
      "the agent's answer to SEND NOW",
      30_000,
    );
    expect(sentNowOf(tap, followUp.turn.id)?.payload).toEqual({
      type: "message.sent_now",
      moved: false,
    });
    await waitFor(
      () => readTurn(stack.v1, conversationId, followUp.turn.id),
      (row) => row?.status === "joined",
      "the follow-up to be read",
      60_000,
    );
    await tap.close();
    await runner.pausePump();
  },
);
