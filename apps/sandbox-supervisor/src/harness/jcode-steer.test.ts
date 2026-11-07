import { describe, expect, it } from "vitest";
import {
  createLiveSteerTracker,
  type LiveSteerTracker,
  type SteerFrame,
} from "./jcode-steer";

/**
 * The live pickup tracker, frame by frame: the reply rule `replyAfter` pins
 * for the history path, applied to the stream instead. One source of truth
 * for what a reply IS; two readers of it (live, history).
 *
 * Two events, in a fixed order: `message.joined` the moment the injection
 * lands (before any word of the reply), `message.replied` once the reply is
 * complete (and only when there is one).
 */

const steer = (id: string) => ({ id, message: `steer ${id}` });

/** The events a frame completed (most assertions care about nothing else). */
const events = (t: LiveSteerTracker, frame: SteerFrame) =>
  t.observe(frame).events;

const joined = (followUpId: string) => ({
  type: "message.joined" as const,
  followUpId,
});
const replied = (followUpId: string, reply: string) => ({
  type: "message.replied" as const,
  followUpId,
  reply,
});

describe("the live steer tracker", () => {
  it("confirms an injection's steers AT the injection, and takes the next message as the reply", () => {
    const t = createLiveSteerTracker();
    t.sent(steer("f1"));
    expect(events(t, { kind: "injected", clientIds: ["f1"] })).toEqual([
      joined("f1"),
    ]);
    expect(
      events(t, { kind: "text", messageId: "m1", text: "Sure, " }),
    ).toEqual([]);
    expect(
      events(t, { kind: "text", messageId: "m1", text: "on it." }),
    ).toEqual([]);
    expect(events(t, { kind: "text_done", messageId: "m1" })).toEqual([
      replied("f1", "Sure, on it."),
    ]);
    expect(t.unconfirmed()).toEqual([]);
  });

  it("a tool call first means a join with no reply at all", () => {
    const t = createLiveSteerTracker();
    t.sent(steer("f1"));
    expect(events(t, { kind: "injected", clientIds: ["f1"] })).toEqual([
      joined("f1"),
    ]);
    expect(events(t, { kind: "tool_start" })).toEqual([]);
  });

  it("a tool call cuts a reply short: the words before it are the reply", () => {
    const t = createLiveSteerTracker();
    t.sent(steer("f1"));
    t.observe({ kind: "injected", clientIds: ["f1"] });
    t.observe({ kind: "text", messageId: "m1", text: "Checking now." });
    expect(events(t, { kind: "tool_start" })).toEqual([
      replied("f1", "Checking now."),
    ]);
  });

  it("the terminal closes a reply still being read", () => {
    const t = createLiveSteerTracker();
    t.sent(steer("f1"));
    t.observe({ kind: "injected", clientIds: ["f1"] });
    t.observe({ kind: "text", messageId: "m1", text: "Yes." });
    expect(events(t, { kind: "terminal" })).toEqual([replied("f1", "Yes.")]);
  });

  it("a second framed message begins: the first was the whole reply", () => {
    const t = createLiveSteerTracker();
    t.sent(steer("f1"));
    t.observe({ kind: "injected", clientIds: ["f1"] });
    t.observe({ kind: "text", messageId: "m1", text: "Reply." });
    expect(
      events(t, { kind: "text", messageId: "m2", text: "Back to work." }),
    ).toEqual([replied("f1", "Reply.")]);
    // The second message is not anyone's reply.
    expect(events(t, { kind: "text_done", messageId: "m2" })).toEqual([]);
  });

  it("a text_done for another message is not the reply's close", () => {
    const t = createLiveSteerTracker();
    t.sent(steer("f1"));
    t.observe({ kind: "injected", clientIds: ["f1"] });
    t.observe({ kind: "text", messageId: "m1", text: "Reply." });
    expect(events(t, { kind: "text_done", messageId: "m0" })).toEqual([]);
    expect(events(t, { kind: "text_done", messageId: "m1" })).toHaveLength(1);
  });

  it("steers injected together: all join at once; one reply, on the LAST sent", () => {
    const t = createLiveSteerTracker();
    t.sent(steer("f1"));
    t.sent(steer("f2"));
    t.sent(steer("f3"));
    expect(
      events(t, { kind: "injected", clientIds: ["f1", "f2", "f3"] }),
    ).toEqual([joined("f1"), joined("f2"), joined("f3")]);
    t.observe({ kind: "text", messageId: "m1", text: "All three: yes." });
    expect(events(t, { kind: "text_done", messageId: "m1" })).toEqual([
      replied("f3", "All three: yes."),
    ]);
  });

  it("a later injection closes an earlier reply still open, then joins", () => {
    // `replyAfter` reads "another user message" as the end of a reply. The
    // earlier reply closes BEFORE the new join: the order a reader of the
    // stream needs (that reply is done; this message is in).
    const t = createLiveSteerTracker();
    t.sent(steer("f1"));
    t.sent(steer("f2"));
    t.observe({ kind: "injected", clientIds: ["f1"] });
    t.observe({ kind: "text", messageId: "m1", text: "First." });
    expect(events(t, { kind: "injected", clientIds: ["f2"] })).toEqual([
      replied("f1", "First."),
      joined("f2"),
    ]);
    t.observe({ kind: "text", messageId: "m2", text: "Second." });
    expect(events(t, { kind: "terminal" })).toEqual([replied("f2", "Second.")]);
  });

  it("ignores ids it never sent, and reports the unconfirmed ones", () => {
    const t = createLiveSteerTracker();
    t.sent(steer("f1"));
    t.sent(steer("f2"));
    expect(events(t, { kind: "injected", clientIds: ["stale", "f1"] })).toEqual(
      [joined("f1")],
    );
    t.observe({ kind: "text", messageId: "m1", text: "ok" });
    expect(events(t, { kind: "terminal" })).toEqual([replied("f1", "ok")]);
    expect(t.unconfirmed()).toEqual([steer("f2")]);
  });

  it("an injection of nothing but foreign ids is no event", () => {
    const t = createLiveSteerTracker();
    t.sent(steer("f1"));
    expect(events(t, { kind: "injected", clientIds: ["stale"] })).toEqual([]);
    expect(t.unconfirmed()).toEqual([steer("f1")]);
  });

  it("a correction of the reply's message replaces its text; another's does not", () => {
    const t = createLiveSteerTracker();
    t.sent(steer("f1"));
    t.observe({ kind: "injected", clientIds: ["f1"] });
    t.observe({ kind: "text", messageId: "m1", text: "Yes, I can also em" });
    t.observe({ kind: "replace", messageId: "m9", text: "unrelated" });
    t.observe({
      kind: "replace",
      messageId: "m1",
      text: "Yes, I can also email it.",
    });
    expect(events(t, { kind: "text_done", messageId: "m1" })).toEqual([
      replied("f1", "Yes, I can also email it."),
    ]);
  });

  it("a blank reply is no reply", () => {
    const t = createLiveSteerTracker();
    t.sent(steer("f1"));
    t.observe({ kind: "injected", clientIds: ["f1"] });
    t.observe({ kind: "text", messageId: "m1", text: "  \n" });
    expect(events(t, { kind: "text_done", messageId: "m1" })).toEqual([]);
  });

  it("an unframed bridge (no message ids): one reply until a tool or the terminal", () => {
    const t = createLiveSteerTracker();
    t.sent(steer("f1"));
    t.observe({ kind: "injected", clientIds: ["f1"] });
    t.observe({ kind: "text", messageId: undefined, text: "Yes, " });
    t.observe({ kind: "text", messageId: undefined, text: "I can." });
    // An id-less text_done (never sent by such a bridge) would not close it
    // either way; the tool does.
    expect(events(t, { kind: "text_done", messageId: undefined })).toEqual([]);
    expect(events(t, { kind: "tool_start" })).toEqual([
      replied("f1", "Yes, I can."),
    ]);
  });

  it("bounds a runaway reply", () => {
    const t = createLiveSteerTracker();
    t.sent(steer("f1"));
    t.observe({ kind: "injected", clientIds: ["f1"] });
    t.observe({ kind: "text", messageId: "m1", text: "x".repeat(300_000) });
    const [event] = events(t, { kind: "terminal" });
    expect(event?.type).toBe("message.replied");
    expect(event?.type === "message.replied" && event.reply.length).toBe(
      256_000,
    );
  });
});

describe("the reply, as it streams", () => {
  // Each text frame the open reply absorbs names the follow-up it answers,
  // so the adapter can forward that delta under the follow-up's id while
  // the agent is still writing. A frame that CLOSES the reply is never part
  // of it.

  it("names the replier on every delta of the reply message", () => {
    const t = createLiveSteerTracker();
    t.sent(steer("f1"));
    t.observe({ kind: "injected", clientIds: ["f1"] });
    expect(
      t.observe({ kind: "text", messageId: "m1", text: "Sure, " }),
    ).toEqual({ events: [], replyTo: "f1" });
    expect(
      t.observe({ kind: "text", messageId: "m1", text: "on it." }),
    ).toEqual({ events: [], replyTo: "f1" });
  });

  it("the delta that starts the NEXT message is the turn's own, and closes the reply", () => {
    const t = createLiveSteerTracker();
    t.sent(steer("f1"));
    t.observe({ kind: "injected", clientIds: ["f1"] });
    t.observe({ kind: "text", messageId: "m1", text: "Reply." });
    const next = t.observe({
      kind: "text",
      messageId: "m2",
      text: "Back to work.",
    });
    expect(next.replyTo).toBeUndefined();
    expect(next.events).toEqual([replied("f1", "Reply.")]);
    // And nothing after it is tagged either.
    expect(
      t.observe({ kind: "text", messageId: "m2", text: " More." }).replyTo,
    ).toBeUndefined();
  });

  it("the turn's narration before any injection is never tagged", () => {
    const t = createLiveSteerTracker();
    t.sent(steer("f1"));
    expect(
      t.observe({ kind: "text", messageId: "m0", text: "Working." }).replyTo,
    ).toBeUndefined();
  });

  it("steers injected together: the deltas are the LAST one's reply", () => {
    const t = createLiveSteerTracker();
    t.sent(steer("f1"));
    t.sent(steer("f2"));
    t.observe({ kind: "injected", clientIds: ["f1", "f2"] });
    expect(
      t.observe({ kind: "text", messageId: "m1", text: "Both: yes." }).replyTo,
    ).toBe("f2");
  });

  it("an unframed bridge tags the whole stretch after the injection, until a tool", () => {
    const t = createLiveSteerTracker();
    t.sent(steer("f1"));
    t.observe({ kind: "injected", clientIds: ["f1"] });
    expect(
      t.observe({ kind: "text", messageId: undefined, text: "Yes, " }).replyTo,
    ).toBe("f1");
    expect(t.observe({ kind: "tool_start" }).replyTo).toBeUndefined();
    expect(
      t.observe({ kind: "text", messageId: undefined, text: "Done." }).replyTo,
    ).toBeUndefined();
  });

  it("a correction is never tagged: it has no wire form", () => {
    const t = createLiveSteerTracker();
    t.sent(steer("f1"));
    t.observe({ kind: "injected", clientIds: ["f1"] });
    t.observe({ kind: "text", messageId: "m1", text: "Yes, I can also em" });
    expect(
      t.observe({ kind: "replace", messageId: "m1", text: "Yes." }),
    ).toEqual({ events: [] });
  });
});
