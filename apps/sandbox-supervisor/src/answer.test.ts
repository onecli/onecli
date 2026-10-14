import { describe, expect, it } from "vitest";
import {
  ceilingWarningSteerId,
  type HarnessEvent,
} from "@onecli/agent-protocol";
import {
  createAnswerTracker,
  MAX_ANSWER_CHARS,
  replyTargetOf,
  toWireEvent,
} from "./answer";

/** Feed a turn's events and read the answer the transcript would keep. */
const answerOf = (events: HarnessEvent[]): string => {
  const tracker = createAnswerTracker();
  for (const event of events) tracker.observe(event);
  return tracker.answer();
};

const say = (text: string, messageId?: string): HarnessEvent => ({
  type: "text.delta",
  text,
  ...(messageId !== undefined && { messageId }),
});
const correct = (messageId: string, text: string): HarnessEvent => ({
  type: "text.replace",
  messageId,
  text,
});
const tool = (callId: string): HarnessEvent[] => [
  { type: "tool.started", callId, name: "bash" },
  { type: "tool.finished", callId, name: "bash", output: "ok" },
];
const think = (text: string): HarnessEvent => ({
  type: "thinking.delta",
  text,
});

describe("the answer: framed output (the harness names each message)", () => {
  it("keeps two messages written with no tool between them as two paragraphs, never glued", () => {
    // The steered-reply shape: the agent finishes its answer, then
    // answers a message the user sent mid-turn, with no tool in between.
    // MUTATION-PROOF: join on "" and this reads "…report.md.Yes, …".
    expect(
      answerOf([
        ...tool("c1"),
        say("Done: the report is in ", "m1"),
        say("report.md.", "m1"),
        say("Yes, I can also email it.", "m2"),
        { type: "turn.done" },
      ]),
    ).toBe("Done: the report is in report.md.\n\nYes, I can also email it.");
  });

  it("keeps one message whole across a thinking block", () => {
    // Thinking interleaves INSIDE a message; the id does not change.
    expect(
      answerOf([
        say("The root cause is ", "m1"),
        think("let me double check"),
        say("the retry loop.", "m1"),
      ]),
    ).toBe("The root cause is the retry loop.");
  });

  it("still drops narration: only what follows the last tool call is the answer", () => {
    expect(
      answerOf([
        say("Let me check the logs.", "m1"),
        ...tool("c1"),
        say("Now the config.", "m2"),
        ...tool("c2"),
        say("CI passed; nothing to do.", "m3"),
      ]),
    ).toBe("CI passed; nothing to do.");
  });

  it("a retracted attempt leaves no trace: the replayed answer stands alone", () => {
    // The provider failed mid-stream and the harness replayed the request:
    // it retracts the partial (empty replace) and streams a new message.
    // MUTATION-PROOF: ignore `text.replace` and the partial is glued in
    // front of the real answer.
    expect(
      answerOf([
        say("PARTIAL attempt text ", "m1"),
        correct("m1", ""),
        say("THE-FINAL-ANSWER", "m2"),
      ]),
    ).toBe("THE-FINAL-ANSWER");
  });

  it("a correction replaces the message's text in place", () => {
    expect(
      answerOf([
        say("valid <tool_call>{garbage", "m1"),
        correct("m1", "valid"),
        say("Second paragraph.", "m2"),
      ]),
    ).toBe("valid\n\nSecond paragraph.");
  });

  it("a correction for a message never streamed is new text (a recovered suffix)", () => {
    expect(answerOf([correct("m1", "Retained suffix")])).toBe(
      "Retained suffix",
    );
  });

  it("corrects a message whose tool call already closed its stretch", () => {
    // The harness announces a tool call while the response is still
    // streaming, so a correction for that response's text arrives after the
    // stretch closed. It must land on the message, not start a new one.
    expect(
      answerOf([
        say("Running it, see <wrapped>", "m1"),
        { type: "tool.started", callId: "c1", name: "bash" },
        correct("m1", "Running it."),
        { type: "error", message: "stopped" },
      ]),
    ).toBe("Running it.");
  });

  it("a retraction that arrives after the tool call was announced still retracts", () => {
    // The provider attempt was cut after its tool call was announced. The
    // retraction must find the message in the stretch the call closed.
    // MUTATION-PROOF: look framed ids up in the current stretch only and
    // the retracted partial survives as the fallback answer.
    expect(
      answerOf([
        say("PARTIAL attempt ", "m1"),
        { type: "tool.started", callId: "c1", name: "bash" },
        correct("m1", ""),
        { type: "error", message: "stopped" },
      ]),
    ).toBe("");
  });

  it("a correction for narration the answer already let go of changes nothing", () => {
    // Two tool calls later, the first stretch is neither the answer nor its
    // fallback. A late correction for it must not resurface as answer text.
    expect(
      answerOf([
        say("Narration.", "m1"),
        ...tool("c1"),
        say("Middle.", "m2"),
        ...tool("c2"),
        correct("m1", "Narration, corrected."),
        say("Final.", "m3"),
      ]),
    ).toBe("Final.");
  });

  it("a message retracted before a tool call does not come back after it", () => {
    // The retracted message's stretch closed with nothing said, so it is let
    // go too. MUTATION-PROOF: skip retiring an empty stretch's ids and the
    // late correction lands in the answer, ahead of the real reply.
    expect(
      answerOf([
        say("Partial", "m1"),
        correct("m1", ""),
        ...tool("c1"),
        correct("m1", "Narration, back again."),
        say("Final.", "m2"),
      ]),
    ).toBe("Final.");
  });

  it("an empty delta is not a message: it claims no id", () => {
    // Text for that id after a tool call is the answer, not a retired
    // message. MUTATION-PROOF: drop the empty-text guard and the empty
    // delta registers m1, the tool call retires it, and the answer is lost.
    expect(
      answerOf([say("", "m1"), ...tool("c1"), say("The answer.", "m1")]),
    ).toBe("The answer.");
  });

  it("falls back to the last stretch that said something when the closing one was retracted", () => {
    expect(
      answerOf([
        say("Starting the deploy.", "m1"),
        ...tool("c1"),
        say("half a sent", "m2"),
        correct("m2", ""),
        { type: "error", message: "the harness died" },
      ]),
    ).toBe("Starting the deploy.");
  });
});

describe("the answer: unframed output (today's rule, unchanged)", () => {
  it("joins deltas within a stretch, so a streamed sentence stays whole", () => {
    expect(
      answerOf([...tool("c1"), say("All "), say("four "), say("gates.")]),
    ).toBe("All four gates.");
  });

  it("falls back to the last thing said when a turn ends mid-tool", () => {
    expect(
      answerOf([
        say("Starting the deploy."),
        { type: "tool.started", callId: "c1", name: "bash" },
        { type: "error", message: "the harness died" },
      ]),
    ).toBe("Starting the deploy.");
  });

  it("does not let back-to-back tools erase the last words said", () => {
    expect(
      answerOf([say("Found the cause."), ...tool("c1"), ...tool("c2")]),
    ).toBe("Found the cause.");
  });

  it("is empty when the agent never said anything", () => {
    expect(answerOf([...tool("c1"), { type: "turn.done" }])).toBe("");
  });

  it("never treats whitespace as words", () => {
    expect(answerOf([say("Real words."), ...tool("c1"), say("\n  ")])).toBe(
      "Real words.",
    );
  });
});

describe("the answer: the memory guard", () => {
  it("stops growing at the cap, framed or not", () => {
    const chunk = "x".repeat(MAX_ANSWER_CHARS / 2);
    for (const id of [undefined, "m1"]) {
      const answer = answerOf([say(chunk, id), say(chunk, id), say("y", id)]);
      expect(answer.length).toBe(MAX_ANSWER_CHARS);
    }
  });

  it("bounds a correction to the room its stretch has left", () => {
    const answer = answerOf([
      say("x".repeat(MAX_ANSWER_CHARS - 10), "m1"),
      say("short", "m2"),
      correct("m2", "y".repeat(100)),
    ]);
    expect(answer.length).toBe(MAX_ANSWER_CHARS + "\n\n".length);
  });
});

describe("the answer: a follow-up's reply is handed over, never kept twice", () => {
  /** Feed a turn, claim one reply, and read back both decisions. */
  const claimed = (events: HarnessEvent[], reply: string) => {
    const tracker = createAnswerTracker();
    for (const event of events) tracker.observe(event);
    return { claimed: tracker.claim("f1", reply), answer: tracker.answer() };
  };

  it("moves a reply written back to back with the answer out of it", () => {
    // Point B: the agent finished, then answered the follow-up, no tool
    // between. MUTATION-PROOF: without the claim the reply is stored twice
    // (under the follow-up and glued under the turn's answer).
    expect(
      claimed(
        [
          say("Done: the report is in report.md.", "m1"),
          say("Yes, I can also email it.", "m2"),
        ],
        "Yes, I can also email it.",
      ),
    ).toEqual({ claimed: true, answer: "Done: the report is in report.md." });
  });

  it("hands over a reply the answer had already let go of, and keeps the answer", () => {
    // Point D: the reply was narration before more tool calls.
    expect(
      claimed(
        [
          say("Running the build.", "m1"),
          ...tool("c1"),
          say("Sure, I'll check the linter too.", "m2"),
          ...tool("c2"),
          say("Build and lint both passed.", "m3"),
        ],
        "Sure, I'll check the linter too.",
      ),
    ).toEqual({ claimed: true, answer: "Build and lint both passed." });
  });

  it("never takes the turn's closing words, even when they are the reply", () => {
    // One message answering the request and the follow-up together.
    // MUTATION-PROOF: dropping the guard empties the turn's answer.
    expect(
      claimed(
        [...tool("c1"), say("It printed slept, and 17 times 3 is 51.", "m1")],
        "It printed slept, and 17 times 3 is 51.",
      ),
    ).toEqual({
      claimed: false,
      answer: "It printed slept, and 17 times 3 is 51.",
    });
  });

  it("keeps a stopped turn's last words as its answer", () => {
    // Stopped mid-tool right after replying: the reply is all it said.
    expect(
      claimed(
        [say("Sure, checking that now.", "m1"), ...tool("c1")],
        "Sure, checking that now.",
      ),
    ).toEqual({ claimed: false, answer: "Sure, checking that now." });
  });

  it("matches the latest copy when the same words were said twice", () => {
    // Both copies in ONE stretch, so the order inside it decides.
    // MUTATION-PROOF: scan oldest first and the earlier "On it." leaves,
    // flipping the answer's paragraphs.
    expect(
      claimed(
        [say("On it.", "m1"), say("Done.", "m2"), say("On it.", "m3")],
        "On it.",
      ),
    ).toEqual({ claimed: true, answer: "On it.\n\nDone." });
  });

  it("hands over a reply from a stretch the answer let go of long ago", () => {
    // The agent replied, then worked through two more tool calls: the reply
    // is no longer anywhere the answer looks, so there is nothing to take
    // out, and it is still the follow-up's. MUTATION-PROOF: refuse an
    // unmatched reply and the person's question goes unanswered again.
    expect(
      claimed(
        [
          say("Sure, I'll check the linter too.", "m1"),
          ...tool("c1"),
          say("Now the linter.", "m2"),
          ...tool("c2"),
          say("Build and lint both passed.", "m3"),
        ],
        "Sure, I'll check the linter too.",
      ),
    ).toEqual({ claimed: true, answer: "Build and lint both passed." });
  });

  it("matches the streamed message despite whitespace around it", () => {
    // History is trimmed, the stream is not. MUTATION-PROOF: compare the
    // raw text and the reply stays in the answer AND goes to the follow-up.
    expect(
      claimed(
        [say("Done.", "m1"), say("\nSure, emailing it.\n", "m2")],
        "Sure, emailing it.",
      ),
    ).toEqual({ claimed: true, answer: "Done." });
  });

  it("gives the claimed words' room back to the memory guard", () => {
    // The tracker keeps observing after a claim (a reply can be settled
    // before the turn ends), so the cap must count what is still kept.
    // MUTATION-PROOF: keep the claimed length on the books and the later
    // words are refused as if the stretch were full.
    const tracker = createAnswerTracker();
    tracker.observe(say("Done.", "m1"));
    tracker.observe(say("y".repeat(MAX_ANSWER_CHARS - 10), "m2"));
    expect(tracker.claim("f1", "y".repeat(MAX_ANSWER_CHARS - 10))).toBe(true);
    tracker.observe(say("x".repeat(100), "m3"));
    tracker.observe(say("z", "m4"));
    expect(tracker.answer()).toBe(`Done.\n\n${"x".repeat(100)}\n\nz`);
  });

  it("refuses an empty reply", () => {
    expect(claimed([say("Done.", "m1")], "  ")).toEqual({
      claimed: false,
      answer: "Done.",
    });
  });
});

describe("the answer: a reply claimed while it is the closing words", () => {
  // The join arrives LIVE, the moment the reply's message closes, while the
  // turn still runs. The rule is unchanged (the closing words are never
  // taken); what differs is WHEN the facts are in: a reply that is the
  // answer's only words now may not be so once the turn goes on. So the
  // claim holds it, and the first event showing the agent moved on (the
  // next tool call, or the next words) hands it over.
  /** Feed events and collect every reply they handed over. */
  const feed = (
    tracker: ReturnType<typeof createAnswerTracker>,
    events: HarnessEvent[],
  ) => events.flatMap((event) => tracker.observe(event));

  it("hands a held reply over at the tool call that follows it: the agent went back to work", () => {
    // Point D, the common case: narration, a tool, the reply, more work,
    // the final answer. The reply is handed over the moment the next tool
    // starts (a channel reader gets it while the agent works), not
    // at the final answer. MUTATION-PROOF: refuse instead of hold and the
    // reply is never stored under the follow-up (the live-pickup finding on
    // jcode v0.94.0); hold through the tool and Slack posts it at the close.
    const tracker = createAnswerTracker();
    feed(tracker, [
      say("Running the build.", "m1"),
      ...tool("c1"),
      say("Sure, I'll check the linter too.", "m2"),
    ]);
    // Only words after the last tool call: the reply IS the answer so far.
    expect(tracker.claim("f1", "Sure, I'll check the linter too.")).toBe(false);
    expect(tracker.answer()).toBe("Sure, I'll check the linter too.");
    // The tool call that follows hands it over RIGHT THERE.
    expect(
      feed(tracker, [{ type: "tool.started", callId: "c2", name: "bash" }]),
    ).toEqual([
      { followUpId: "f1", reply: "Sure, I'll check the linter too." },
    ]);
    // A stop during that tool: the reply is the follow-up's, and the turn's
    // answer falls back to what it said before (never the reply twice).
    expect(tracker.answer()).toBe("Running the build.");
    feed(tracker, [
      { type: "tool.finished", callId: "c2", name: "bash", output: "" },
    ]);
    expect(feed(tracker, [say("Both", "m3"), say(" passed.", "m3")])).toEqual(
      [],
    );
    expect(tracker.answer()).toBe("Both passed.");
  });

  it("hands a held reply over when the next message starts, with no tool between", () => {
    // The agent replied, then wrote on in a new message.
    const tracker = createAnswerTracker();
    feed(tracker, [...tool("c1"), say("Blue.", "m1")]);
    expect(tracker.claim("f1", "Blue.")).toBe(false);
    expect(feed(tracker, [say("Now the report: all green.", "m2")])).toEqual([
      { followUpId: "f1", reply: "Blue." },
    ]);
    expect(tracker.answer()).toBe("Now the report: all green.");
  });

  it("keeps a held reply as the turn's answer when nothing followed it", () => {
    // Stopped (or finished) right after the reply: it is all the turn said
    // after its last tool, so the answer keeps it and the follow-up gets
    // nothing of its own. MUTATION-PROOF: hand it over anyway and the
    // turn's answer is emptied.
    const tracker = createAnswerTracker();
    feed(tracker, [...tool("c1"), say("Blue.", "m1")]);
    expect(tracker.claim("f1", "Blue.")).toBe(false);
    expect(feed(tracker, [{ type: "turn.done" }])).toEqual([]);
    expect(tracker.answer()).toBe("Blue.");
  });

  it("a reply followed by tool calls alone is the follow-up's; the turn keeps the words before it", () => {
    // The reply, then back-to-back tool calls, then a stop: the reply was
    // handed over at the first tool (the agent moved on), and the turn's
    // answer falls back to the last thing it said before the reply.
    const tracker = createAnswerTracker();
    feed(tracker, [say("Starting.", "m0"), ...tool("c0"), say("Blue.", "m1")]);
    expect(tracker.claim("f1", "Blue.")).toBe(false);
    expect(
      feed(tracker, [{ type: "tool.started", callId: "c1", name: "bash" }]),
    ).toEqual([{ followUpId: "f1", reply: "Blue." }]);
    expect(
      feed(tracker, [
        { type: "tool.finished", callId: "c1", name: "bash", output: "" },
        ...tool("c2"),
      ]),
    ).toEqual([]);
    expect(tracker.answer()).toBe("Starting.");
  });

  it("hands several held replies over in claim order", () => {
    const tracker = createAnswerTracker();
    feed(tracker, [...tool("c1"), say("First.", "m1")]);
    expect(tracker.claim("f1", "First.")).toBe(false);
    expect(feed(tracker, tool("c2"))).toEqual([
      { followUpId: "f1", reply: "First." },
    ]);
    feed(tracker, [say("Second.", "m2")]);
    expect(tracker.claim("f2", "Second.")).toBe(false);
    expect(feed(tracker, tool("c3"))).toEqual([
      { followUpId: "f2", reply: "Second." },
    ]);
    expect(feed(tracker, [say("All done.", "m3")])).toEqual([]);
    expect(tracker.answer()).toBe("All done.");
  });

  it("never holds a blank reply", () => {
    const tracker = createAnswerTracker();
    feed(tracker, [say("Done.", "m1")]);
    expect(tracker.claim("f1", "  ")).toBe(false);
    expect(feed(tracker, [...tool("c1"), say("More.", "m2")])).toEqual([]);
    expect(tracker.answer()).toBe("More.");
  });
});

describe("toWireEvent: framing stops at the supervisor", () => {
  it("strips the message id from a delta", () => {
    expect(toWireEvent(say("hi", "m1"))).toEqual({
      type: "text.delta",
      text: "hi",
    });
  });

  it("has no wire form for a correction", () => {
    expect(toWireEvent(correct("m1", ""))).toBeNull();
  });

  it("has no wire form for a finished reply: it travels as its own text", () => {
    expect(
      toWireEvent({
        type: "message.replied",
        followUpId: "f1",
        reply: "Sure, I'll do that too.",
      }),
    ).toBeNull();
  });

  it("passes a join through untouched", () => {
    const joined: HarnessEvent = { type: "message.joined", followUpId: "f1" };
    expect(toWireEvent(joined)).toBe(joined);
  });

  it("passes every other event through untouched", () => {
    const done: HarnessEvent = { type: "turn.done" };
    expect(toWireEvent(done)).toBe(done);
  });

  it("strips the reply target from a delta: it travels as the row's own words", () => {
    expect(
      toWireEvent({
        type: "text.delta",
        text: "Sure, ",
        messageId: "m2",
        replyTo: "f1",
      }),
    ).toEqual({ type: "text.delta", text: "Sure, " });
  });
});

describe("replyTargetOf: which row a reply streams under", () => {
  it("a delta marked as a follow-up's reply travels under that follow-up", () => {
    expect(
      replyTargetOf({ type: "text.delta", text: "Sure", replyTo: "f1" }),
    ).toBe("f1");
  });

  it("the turn's own narration has no target", () => {
    expect(replyTargetOf(say("Working.", "m1"))).toBeUndefined();
    expect(replyTargetOf({ type: "turn.done" })).toBeUndefined();
  });

  it("the platform's own steer has no row, so its reply stays the turn's", () => {
    // MUTATION-PROOF: drop the guard and the ceiling warning's reply streams
    // under an id the control plane cannot fence to a row.
    expect(
      replyTargetOf({
        type: "text.delta",
        text: "Wrapping up.",
        replyTo: ceilingWarningSteerId("t1"),
      }),
    ).toBeUndefined();
  });
});
