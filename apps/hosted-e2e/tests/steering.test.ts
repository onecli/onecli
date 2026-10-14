import { expect } from "vitest";
import { STEERED_FOLLOW_UP_CONTEXT } from "@onecli/api/validations/conversation";
import { scenario, type Cx } from "../src/scenario.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import {
  fakeDirective,
  sleep,
  text,
  tool,
  type FakeStep,
} from "../src/fake-dsl.js";
import {
  fetchTranscript,
  openStream,
  readTurn,
  transcriptText,
  waitFor,
  type StreamTap,
  type TranscriptEvent,
} from "../src/v1.js";

/**
 * Mid-run steering, end to end: a message posted while a turn runs JOINS the
 * live run instead of queueing behind it, and the agent's reply to it is
 * stored UNDER that message (its own row's `text`), never lost to the turn's
 * closing words. The sleep steps are the runway the directive seam exists to
 * provide, the thing the in-process steering tests could reach only through
 * a constructor option. The fake harness answers a steer with a
 * `[steered: …]` echo as its own message, the shape a real runtime's next
 * message after an injection has. The echo carries exactly what the
 * harness was handed, so it is the proof that a person's follow-up reaches
 * the model FRAMED (the control plane's "a new message arrived" context,
 * composed in front of the words at the supervisor's boundary) while the
 * stored row keeps the bare words.
 */

/** The durable answer a turn row holds, if any. */
const answerOf = (events: TranscriptEvent[], turnId: string) =>
  events
    .filter((event) => event.turnId === turnId && event.type === "text")
    .map((event) => event.payload["text"]);

/** What the fake echoes back for the follow-up every scenario here sends:
 * the frame, then the person's words, as the model would see them. */
const FRAMED_ECHO = `[steered: ${STEERED_FOLLOW_UP_CONTEXT}\n\nchange of plan mid-flight]`;

/**
 * Run one turn with `steps`, post a follow-up once it is genuinely RUNNING
 * (through the whatever-the-agent-is-doing door), wait for both to settle,
 * and return the stored transcript with the two row ids.
 */
const steerIntoTurn = async (cx: Cx, steps: FakeStep[]) => {
  const stack = await cx.startStack();
  if (stack.runner === null) throw new Error("runner expected");
  await seedTenant(cx.prisma, cx.ids);
  await seedHostedAgent(cx.prisma, cx.ids, { runnerId: stack.runner.runnerId });
  await seedAnthropicGrant(cx.prisma, cx.ids);
  stack.runner.pump();

  const conversation = await stack.v1.json<{ id: string }>(
    await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
  );
  const created = await stack.v1.json<{ id: string }>(
    await stack.v1.post(`/v1/conversations/${conversation.id}/turns`, {
      message: fakeDirective(steps),
    }),
  );
  // A live tail, open before the follow-up exists: the reply must FLOW to
  // an attached reader as it is written, keyed by the follow-up's own id
  // (history carries no deltas, so only a tail can prove it).
  const tap: StreamTap = await openStream(
    stack.api.origin,
    cx.ids.apiKey,
    cx.ids.workspace,
    conversation.id,
  );
  await waitFor(
    () => readTurn(stack.v1, conversation.id, created.id),
    (turn) => turn?.status === "running",
    "the long turn to start",
  );
  const followUp = await stack.v1.json<{ turn: { id: string } }>(
    await stack.v1.post(`/v1/conversations/${conversation.id}/messages`, {
      message: "change of plan mid-flight",
    }),
  );

  // THE LIVE PICKUP: the follow-up's row flips `joined` the
  // moment the run has it, while the turn is still running. Observed as a
  // pair read in that order (the follow-up first, then the target) so a
  // `joined` seen next to a still-`running` target cannot be a race the
  // other way round. The directive leaves the turn running for a while
  // after the injection, which is the window this reads in.
  const joinedWhileRunning = await waitFor(
    async () => {
      const row = await readTurn(stack.v1, conversation.id, followUp.turn.id);
      const target = await readTurn(stack.v1, conversation.id, created.id);
      return { followUp: row?.status, target: target?.status };
    },
    (pair) => pair.followUp === "joined",
    "the follow-up to join while the turn runs",
    120_000,
  );

  await waitFor(
    () => readTurn(stack.v1, conversation.id, created.id),
    (turn) => turn !== null && ["done", "failed"].includes(turn.status),
    "the steered turn to settle",
    120_000,
  );

  const events = await fetchTranscript(stack.v1, conversation.id);
  const followUpRow = await readTurn(
    stack.v1,
    conversation.id,
    followUp.turn.id,
  );
  await tap.close();
  await stack.runner.pausePump();
  return {
    events,
    /** Every frame the live tail saw, in arrival order. */
    streamed: tap.frames.map((frame) => frame.data),
    turnId: created.id,
    followUpId: followUp.turn.id,
    followUpRow,
    joinedWhileRunning,
  };
};

scenario("a follow-up joins the live turn mid-run", async (cx) => {
  // Point D: the turn keeps working after the follow-up lands (a tool call
  // after the injection, the shape where the reply used to be discarded),
  // then says its own closing words. The tool is one no platform serves: a
  // real call round-trip with no side effect (it reports an error). The
  // trailing sleep is the window in which the join must be visible while
  // the turn still runs.
  const {
    events,
    streamed,
    turnId,
    followUpId,
    followUpRow,
    joinedWhileRunning,
  } = await steerIntoTurn(cx, [
    sleep(20_000),
    text("still working"),
    tool("e2e_no_such_tool"),
    sleep(15_000),
    text("after the pause"),
  ]);

  // The row flipped `joined` LIVE: seen while the target was still running,
  // not after it closed.
  expect(joinedWhileRunning).toEqual({ followUp: "joined", target: "running" });

  // THE REPLY STREAMS: on the public stream the reply's
  // words arrived as deltas keyed by the FOLLOW-UP's id, before the turn
  // ended, and the durable `text` under the follow-up followed them. The
  // turn's own deltas never carried the reply.
  const kinds = streamed.map((event) => [event.turnId, event.type]);
  const replyDeltaAt = streamed.findIndex(
    (event) =>
      event.turnId === followUpId &&
      event.type === "text.delta" &&
      String(event.payload["text"]).includes("[steered:"),
  );
  const replyTextAt = kinds.findIndex(
    ([turn, type]) => turn === followUpId && type === "text",
  );
  const turnDoneAt = kinds.findIndex(
    ([turn, type]) => turn === turnId && type === "turn.done",
  );
  expect(replyDeltaAt).toBeGreaterThan(-1);
  expect(replyDeltaAt).toBeLessThan(replyTextAt);
  expect(replyTextAt).toBeLessThan(turnDoneAt);
  expect(
    streamed.some(
      (event) =>
        event.turnId === turnId &&
        event.type === "text.delta" &&
        String(event.payload["text"]).includes("[steered:"),
    ),
  ).toBe(false);

  // The reply is the FOLLOW-UP's own answer, stored once, under its row.
  expect(answerOf(events, followUpId)).toEqual([FRAMED_ECHO]);
  // The turn keeps its own closing words, and not the reply.
  const turnAnswer = answerOf(events, turnId).join("");
  expect(turnAnswer).toContain("after the pause");
  expect(turnAnswer).not.toContain("[steered:");
  expect(transcriptText(events)).toContain("after the pause");
  // The frame is delivery-only: the person's row holds their exact words.
  expect(followUpRow?.message).toBe("change of plan mid-flight");
});

scenario(
  "a follow-up that lands as the agent finishes gets its own reply",
  async (cx) => {
    // Point B: the closing words are already said when the follow-up
    // arrives, and the run goes on to answer it with no tool in between.
    // Before replies were stored per follow-up the two were glued into one
    // answer; now the reply moves under the follow-up and the turn keeps
    // exactly its closing words.
    const { events, turnId, followUpId } = await steerIntoTurn(cx, [
      text("the closing words"),
      sleep(20_000),
    ]);

    expect(answerOf(events, followUpId)).toEqual([FRAMED_ECHO]);
    expect(answerOf(events, turnId)).toEqual(["the closing words"]);
  },
);
