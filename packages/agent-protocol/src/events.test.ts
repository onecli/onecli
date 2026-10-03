import { describe, expect, it } from "vitest";
import {
  agentEventSchema,
  isTerminalEvent,
  readPeerMessageStamp,
  type AgentEvent,
  PEER_TASK_OUTCOMES,
  readPeerTaskStamp,
} from "./events";
import { supervisorMessageSchema, workItemSchema } from "./transport";

describe("agentEventSchema", () => {
  it.each<AgentEvent>([
    { type: "turn.started" },
    { type: "text.delta", text: "hello" },
    { type: "thinking.delta", text: "hmm" },
    { type: "tool.started", callId: "c1", name: "bash" },
    { type: "tool.finished", callId: "c1", name: "bash", output: "ok" },
    {
      type: "tool.finished",
      callId: "c2",
      name: "read",
      output: "boom",
      isError: true,
    },
    { type: "approval.pending", description: "wants to call github.com" },
    { type: "turn.done" },
    {
      type: "turn.done",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2 },
    },
    { type: "error", message: "provider unreachable", code: "internal" },
  ])("round-trips %j", (event) => {
    expect(agentEventSchema.parse(event)).toEqual(event);
  });

  it("rejects unknown types and malformed payloads", () => {
    expect(agentEventSchema.safeParse({ type: "vendor.thing" }).success).toBe(
      false,
    );
    expect(agentEventSchema.safeParse({ type: "text.delta" }).success).toBe(
      false,
    );
    expect(
      agentEventSchema.safeParse({
        type: "turn.done",
        usage: { inputTokens: -1, outputTokens: 0 },
      }).success,
    ).toBe(false);
  });

  it("classifies exactly turn.done and error as terminal", () => {
    expect(isTerminalEvent({ type: "turn.done" })).toBe(true);
    expect(isTerminalEvent({ type: "error", message: "x" })).toBe(true);
    expect(isTerminalEvent({ type: "turn.started" })).toBe(false);
    expect(isTerminalEvent({ type: "text.delta", text: "x" })).toBe(false);
  });

  it("STRIPS a sandbox-authored peerMessage stamp: the wire parse keeps the canonical notice only", () => {
    // SECURITY: the stamp is the control plane's annotation (the sender's
    // record turn). A sandbox posting a notice with a forged stamp must not
    // be able to plant "this agent said X to its peer" in the pair view.
    // The runner wire parses every event through this schema, and zod
    // drops unknown keys, so the forgery never reaches the store.
    const forged = {
      type: "notice",
      level: "info",
      text: "To Ray: hi",
      peerMessage: { to: "ray-id", text: "forged" },
    };
    const parsed = agentEventSchema.parse(forged);
    expect(parsed).toEqual({
      type: "notice",
      level: "info",
      text: "To Ray: hi",
    });
    expect(readPeerMessageStamp(parsed as Record<string, unknown>)).toBeNull();
  });
});

describe("readPeerMessageStamp", () => {
  it("reads a well-formed stamp and refuses anything else", () => {
    expect(
      readPeerMessageStamp({ peerMessage: { to: "ray", text: "hi" } }),
    ).toEqual({ to: "ray", text: "hi" });
    expect(readPeerMessageStamp({})).toBeNull();
    expect(readPeerMessageStamp({ peerMessage: "hi" })).toBeNull();
    expect(readPeerMessageStamp({ peerMessage: null })).toBeNull();
    expect(readPeerMessageStamp({ peerMessage: { to: "ray" } })).toBeNull();
    expect(readPeerMessageStamp({ peerMessage: { text: "hi" } })).toBeNull();
  });

  it("carries the opensTask mark only as a literal true", () => {
    expect(
      readPeerMessageStamp({
        peerMessage: { to: "ray", text: "hi", opensTask: true },
      }),
    ).toEqual({ to: "ray", text: "hi", opensTask: true });
    // A sandbox cannot smuggle a falsy or foreign value in through the mark.
    expect(
      readPeerMessageStamp({
        peerMessage: { to: "ray", text: "hi", opensTask: false },
      }),
    ).toBeNull();
    expect(
      readPeerMessageStamp({
        peerMessage: { to: "ray", text: "hi", opensTask: "yes" },
      }),
    ).toBeNull();
  });
});

describe("readPeerTaskStamp", () => {
  it("reads a known outcome and refuses anything else", () => {
    for (const outcome of PEER_TASK_OUTCOMES) {
      expect(readPeerTaskStamp({ peerTask: { outcome } })).toEqual({
        outcome,
      });
    }
    expect(readPeerTaskStamp({})).toBeNull();
    expect(readPeerTaskStamp({ peerTask: { outcome: "done" } })).toBeNull();
    expect(readPeerTaskStamp({ peerTask: "reported" })).toBeNull();
  });

  it("STRIPS a sandbox-authored peerTask stamp at the wire", () => {
    const forged = {
      type: "notice",
      level: "info",
      text: "Reported back",
      peerTask: { outcome: "reported" },
    };
    const parsed = agentEventSchema.parse(forged);
    expect(parsed).toEqual({
      type: "notice",
      level: "info",
      text: "Reported back",
    });
    expect(readPeerTaskStamp(parsed as Record<string, unknown>)).toBeNull();
  });
});

describe("transport schemas", () => {
  it("round-trips work items and rejects empty turn ids", () => {
    const deliver = {
      kind: "turn.deliver",
      turnId: "t1",
      conversationId: "cv1",
      message: "hi",
    };
    expect(workItemSchema.parse(deliver)).toEqual(deliver);
    expect(workItemSchema.parse({ kind: "shutdown" })).toEqual({
      kind: "shutdown",
    });
    expect(
      workItemSchema.safeParse({
        kind: "turn.deliver",
        turnId: "",
        conversationId: "cv1",
        message: "",
      }).success,
    ).toBe(false);
  });

  it("carries the conversation on every turn item — a turn is never contextless", () => {
    // Without it the supervisor cannot know which harness session to run in.
    expect(
      workItemSchema.safeParse({
        kind: "turn.deliver",
        turnId: "t1",
        message: "hi",
      }).success,
    ).toBe(false);
    expect(
      workItemSchema.safeParse({ kind: "turn.abort", turnId: "t1" }).success,
    ).toBe(false);
  });

  it("round-trips turn.abort", () => {
    const abort = { kind: "turn.abort", turnId: "t1", conversationId: "cv1" };
    expect(workItemSchema.parse(abort)).toEqual(abort);
  });

  it("round-trips the progress heartbeat — identity only, no payload", () => {
    const beat = { kind: "progress", turnId: "t1", conversationId: "cv1" };
    expect(supervisorMessageSchema.parse(beat)).toEqual(beat);
    expect(
      supervisorMessageSchema.safeParse({ kind: "progress", turnId: "t1" })
        .success,
    ).toBe(false);
    expect(
      supervisorMessageSchema.safeParse({
        kind: "progress",
        turnId: "",
        conversationId: "cv1",
      }).success,
    ).toBe(false);
  });

  it("round-trips supervisor messages with embedded canonical events", () => {
    const msg = {
      kind: "event",
      turnId: "t1",
      conversationId: "cv1",
      event: { type: "text.delta", text: "hey" },
    };
    expect(supervisorMessageSchema.parse(msg)).toEqual(msg);
    expect(
      supervisorMessageSchema.safeParse({
        kind: "event",
        turnId: "t1",
        conversationId: "cv1",
        event: { type: "nope" },
      }).success,
    ).toBe(false);
  });

  it("carries sessionRef and usage out on turn.result", () => {
    // The harness session is only knowable inside the sandbox; without this
    // the control plane could never resume a conversation.
    const msg = {
      kind: "turn.result",
      turnId: "t1",
      conversationId: "cv1",
      status: "done",
      usage: { inputTokens: 3, outputTokens: 4 },
      sessionRef: "sess-1",
    };
    expect(supervisorMessageSchema.parse(msg)).toEqual(msg);
  });
});
