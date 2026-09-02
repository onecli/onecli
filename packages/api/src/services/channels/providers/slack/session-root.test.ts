import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * THE SESSION ROOT — which `thread_ts` a Slack turn's work-status receipt is
 * keyed by.
 *
 * This one expression decides whether a conversation gets Slack's native
 * agent loader ("<agent> is working…") or falls back to a "seen" emoji, so
 * it is worth pinning away from the mocks it sits behind.
 *
 * The rule (2026-08-31): a GROUP mention uses the thread root it will answer
 * in; a DM has no thread, so the user's own message is the root. Slack
 * requires a `thread_ts` to scope an agent session at all — it answers
 * `thread_ts_required` without one — which is why a DM cannot simply pass
 * null and still get a loader.
 *
 * The load-bearing safety property, pinned in the last case: keying a DM
 * session by the message ts must NOT change where the answer is posted.
 * Reply addressing is derived from the LINK (`replyTargetForLink` in the
 * channel adapter), never from the receipt — a DM still answers top-level.
 */

const attachTurnReceipt = vi.fn();
const moveTurnReceipt = vi.fn();

vi.mock("../../turn-receipt-service", () => ({
  attachTurnReceipt: (...args: unknown[]) => attachTurnReceipt(...args),
  moveTurnReceipt: (...args: unknown[]) => moveTurnReceipt(...args),
}));

const ingestDirectMessage = vi.fn();
const ingestGroupMessage = vi.fn();

vi.mock("../../channel-ingestion-service", () => ({
  ingestDirectMessage: (...args: unknown[]) => ingestDirectMessage(...args),
  ingestGroupMessage: (...args: unknown[]) => ingestGroupMessage(...args),
  ingestGroupInvite: vi.fn(),
}));

// `db` is only touched by the group door's thread-link check; the DM and
// mention paths under test never reach it.
vi.mock("@onecli/db", () => ({
  db: { channelThreadLink: { findUnique: vi.fn().mockResolvedValue({}) } },
}));

const { dispatchSlackEvent } = await import("./dispatch");

const TURN = {
  kind: "turn" as const,
  conversationId: "cv1",
  turn: { id: "t1", errorCode: null },
};

beforeEach(() => {
  attachTurnReceipt.mockClear();
  moveTurnReceipt.mockClear();
  ingestDirectMessage.mockResolvedValue(TURN);
  ingestGroupMessage.mockResolvedValue(TURN);
});

const dmEvent = {
  type: "message",
  channel_type: "im",
  channel: "D100",
  user: "U1",
  text: "hello",
  ts: "1717171717.123456",
};

const mentionEvent = {
  type: "app_mention",
  channel: "C200",
  user: "U1",
  text: "<@BOT> hello",
  ts: "1717171799.999999",
  thread_ts: "1717171700.000001",
};

describe("the Slack session root", () => {
  it("keys a DM session by the user's own message", async () => {
    // Slack refuses a session without a thread_ts, so a DM has to name one.
    // MUTATION-PROOF: restore `threadTs: call.replyThreadTs` and this fails
    // with null — the shape that silently cost every DM its loader.
    await dispatchSlackEvent({
      presenceId: "p1",
      identityRef: "BOT",
      event: dmEvent,
      eventId: "e1",
    });

    expect(attachTurnReceipt).toHaveBeenCalledTimes(1);
    const arg = attachTurnReceipt.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.threadTs).toBe("1717171717.123456");
    expect(arg.channel).toBe("D100");
  });

  it("keys a group session by the thread root, not the message", async () => {
    // A mention answers IN its thread, so the root is the thread's — using
    // the message ts there would scope the session to the wrong place.
    await dispatchSlackEvent({
      presenceId: "p1",
      identityRef: "BOT",
      event: mentionEvent,
      eventId: "e2",
    });

    expect(attachTurnReceipt).toHaveBeenCalledTimes(1);
    const arg = attachTurnReceipt.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.threadTs).toBe("1717171700.000001");
    expect(arg.messageTs).toBe("1717171799.999999");
  });

  it("uses the SAME root when a follow-up moves the mark", async () => {
    // The move's no-mark fallback calls attachTurnReceipt, so a divergence
    // between these two call sites would give a follow-up a different
    // session than the turn it belongs to.
    ingestDirectMessage.mockResolvedValue({
      kind: "followUp",
      conversationId: "cv1",
      turn: { id: "t2", errorCode: null },
    });

    await dispatchSlackEvent({
      presenceId: "p1",
      identityRef: "BOT",
      event: dmEvent,
      eventId: "e3",
    });

    expect(moveTurnReceipt).toHaveBeenCalledTimes(1);
    const arg = moveTurnReceipt.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.threadTs).toBe("1717171717.123456");
  });

  it("never receipts a turn the door refused", async () => {
    // A born-failed turn (no model key) gets no loader: there is nothing
    // running to report on, and the failure is its own message.
    ingestDirectMessage.mockResolvedValue({
      kind: "turn",
      conversationId: "cv1",
      turn: { id: "t3", errorCode: "no_model_key" },
    });

    await dispatchSlackEvent({
      presenceId: "p1",
      identityRef: "BOT",
      event: dmEvent,
      eventId: "e4",
    });

    expect(attachTurnReceipt).not.toHaveBeenCalled();
  });
});
