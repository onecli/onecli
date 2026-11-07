import { describe, expect, it } from "vitest";
import type { HistoryMessage } from "@1jehuang/jcode-sdk";
import { matchJoinedSteers, replyAfter, settleSteers } from "./jcode";

/**
 * The reconcile's pure core. jcode injects queued soft interrupts as fresh
 * user messages, grouping simultaneous ones joined by "\n\n" (verified in
 * v0.71.1 `interrupts.rs`; byte-identical in v0.78.1), and the SDK bridge
 * drops the injection event —
 * so consumption is decided by matching pending steers against the user
 * entries that appeared AFTER the turn's own prompt. The matching rules each
 * exist to kill a specific failure:
 *
 * - substring, not part-equality: a multi-paragraph steer contains "\n\n"
 *   itself and a separator-split matcher would read it as missed forever —
 *   promoting (double-running) every such follow-up;
 * - longest-first with span consumption: overlapping steers must not
 *   double-claim one injected span;
 * - the CALLER passes only post-prompt candidates: the prompt contains the
 *   memory context and the target message verbatim, so matching over it
 *   would false-positive short follow-ups ("ok") into `joined` — and a
 *   false joined is a silently swallowed message.
 */
describe("matchJoinedSteers", () => {
  const steer = (id: string, message: string) => ({ id, message });
  /** Which steers joined, ignoring where: what most rules are about. */
  const ids = (
    pending: { id: string; message: string }[],
    candidates: string[],
  ): string[] => matchJoinedSteers(pending, candidates).map(({ id }) => id);

  it("matches an injected message, and says which entry it landed in", () => {
    expect(
      matchJoinedSteers(
        [steer("a", "also include tests")],
        ["earlier", "also include tests"],
      ),
    ).toEqual([{ id: "a", entry: 1 }]);
  });

  it("matches a MULTI-PARAGRAPH steer whole — never split on the group separator", () => {
    const message = "first paragraph\n\nsecond paragraph";
    expect(ids([steer("a", message)], [message])).toEqual(["a"]);
  });

  it("matches every member of a grouped injection, all in the one entry", () => {
    // Two steers drained together arrive as ONE user entry, joined by \n\n.
    expect(
      matchJoinedSteers(
        [steer("a", "do x"), steer("b", "do y")],
        ["do x\n\ndo y"],
      ).sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual([
      { id: "a", entry: 0 },
      { id: "b", entry: 0 },
    ]);
  });

  it("misses what was never injected", () => {
    expect(
      ids([steer("a", "injected"), steer("b", "dropped")], ["injected"]),
    ).toEqual(["a"]);
  });

  it("never matches ACROSS entry boundaries — one steer lands in one entry", () => {
    // MUTATION-PROOF for per-entry matching: a blob join("\n\n") would make
    // the boundary between two separate injections indistinguishable from an
    // in-entry group separator, and "a\n\nb" would falsely settle joined —
    // the message silently swallowed while the real a and b re-run.
    expect(ids([steer("x", "a\n\nb")], ["a", "b"])).toEqual([]);
    expect(
      ids(
        [steer("a", "a"), steer("b", "b"), steer("x", "a\n\nb")],
        ["a", "b"],
      ).sort(),
    ).toEqual(["a", "b"]);
  });

  it("consumes spans longest-first so overlapping steers never double-claim", () => {
    // "a" is a substring of "abc": if "a" matched first it would claim the
    // span "abc" occupies and BOTH would read joined off one injection.
    expect(ids([steer("short", "a"), steer("long", "abc")], ["abc"])).toEqual([
      "long",
    ]);
  });

  it("counts duplicate messages once per injected copy", () => {
    expect(
      ids([steer("first", "ok"), steer("second", "ok")], ["ok\n\nok"]).sort(),
    ).toEqual(["first", "second"]);
    expect(
      ids([steer("first", "ok"), steer("second", "ok")], ["ok"]),
    ).toHaveLength(1);
  });

  it("never matches an empty message", () => {
    expect(ids([steer("a", "")], ["anything"])).toEqual([]);
  });

  it("answers nothing for no candidates — everything missed, promotion runs it", () => {
    expect(ids([steer("a", "hello")], [])).toEqual([]);
  });
});

/**
 * Reading the agent's reply off the session history. The shapes below are
 * the ones verified live on the pinned runtime (a mid-turn message answered
 * as the model finished, and one answered between tool calls): the history
 * renders the injected message as a user entry and what the agent said next
 * as the following assistant entry, text only.
 */
const entry = (role: string, content: string): HistoryMessage => ({
  role,
  content,
});

describe("replyAfter", () => {
  it("is the assistant entry right after the injection", () => {
    const history = [
      entry("user", "write the report"),
      entry("assistant", "Done: the report is in report.md."),
      entry("user", "can you email it too?"),
      entry("assistant", "Yes, I can also email it."),
    ];
    expect(replyAfter(history, 2)).toBe("Yes, I can also email it.");
  });

  it("is only the words before the agent's next tool call", () => {
    // Between tool batches: the reply, then more work, then the answer.
    const history = [
      entry("user", "run the build"),
      entry("assistant", "Running the build."),
      entry("tool", "built"),
      entry("user", "also check the linter"),
      entry("assistant", "Sure, I'll check the linter too."),
      entry("tool", "linted"),
      entry("assistant", "Build and lint both passed."),
    ];
    expect(replyAfter(history, 3)).toBe("Sure, I'll check the linter too.");
  });

  it("is nothing when the agent went straight back to work", () => {
    // MUTATION-PROOF: skipping tool entries would hand this message the
    // turn's closing words, which belong to the turn.
    const history = [
      entry("user", "also check the linter"),
      entry("tool", "linted"),
      entry("assistant", "Build and lint both passed."),
    ];
    expect(replyAfter(history, 0)).toBeUndefined();
  });

  it("is nothing when the next thing is another message, not an answer", () => {
    const history = [
      entry("user", "first follow-up"),
      entry("user", "second follow-up"),
      entry("assistant", "Both noted."),
    ];
    expect(replyAfter(history, 0)).toBeUndefined();
  });

  it("drops the reasoning lines jcode renders in front of the words", () => {
    // With reasoning display on (the runtime's default), the history entry
    // carries the model's thinking as `*⁣…⁣*  ` lines ahead of
    // what it said. MUTATION-PROOF: return the raw content and the reply
    // shows the agent's private reasoning as if it said it to the person.
    const history = [
      entry("user", "what is the capital of France?"),
      entry(
        "assistant",
        "*\u2063I'll answer and continue with the third echo.\u2063*  \n" +
          "*\u2063Second line of thought.\u2063*  \n\n\n\n" +
          "The capital of France is Paris.",
      ),
    ];
    expect(replyAfter(history, 0)).toBe("The capital of France is Paris.");
  });

  it("keeps the agent's own italics: only the runtime's sentinel lines are reasoning", () => {
    const history = [
      entry("user", "how sure are you?"),
      entry("assistant", "*Fairly* sure.\n*Not certain* about the date."),
    ];
    expect(replyAfter(history, 0)).toBe(
      "*Fairly* sure.\n*Not certain* about the date.",
    );
  });

  it("is nothing when the entry held only reasoning", () => {
    const history = [
      entry("user", "q"),
      entry("assistant", "*\u2063thinking it over\u2063*  \n"),
      entry("tool", "ok"),
    ];
    expect(replyAfter(history, 0)).toBeUndefined();
  });

  it("looks past display-only entries the runtime slots in", () => {
    const history = [
      entry("user", "how is it going?"),
      entry("background_task", "task finished"),
      entry("system", "a note"),
      entry("assistant", "Halfway there."),
    ];
    expect(replyAfter(history, 0)).toBe("Halfway there.");
  });

  it("is nothing for a blank entry or the end of the history", () => {
    expect(
      replyAfter([entry("user", "q"), entry("assistant", "  \n")], 0),
    ).toBeUndefined();
    expect(replyAfter([entry("user", "q")], 0)).toBeUndefined();
  });
});

describe("settleSteers", () => {
  const steer = (id: string, message: string) => ({ id, message });

  it("settles each joined steer with its reply, in send order", () => {
    const history = [
      entry("user", "write the report"),
      entry("assistant", "On it."),
      entry("tool", "ok"),
      entry("user", "use the Q3 numbers"),
      entry("assistant", "Using the Q3 numbers."),
      entry("tool", "ok"),
      entry("user", "and email it"),
      entry("assistant", "I'll email it when done."),
      entry("tool", "ok"),
      entry("assistant", "Report sent."),
    ];
    expect(
      settleSteers(
        [steer("f1", "use the Q3 numbers"), steer("f2", "and email it")],
        history,
        1,
      ),
    ).toEqual([
      { followUpId: "f1", reply: "Using the Q3 numbers." },
      { followUpId: "f2", reply: "I'll email it when done." },
    ]);
  });

  it("gives a grouped injection's one reply to the LAST steer sent", () => {
    // MUTATION-PROOF: giving it to every member would post the same words
    // twice, and to the first one would hang it above the newest question.
    const history = [
      entry("user", "write the report"),
      entry("user", "use Q3\n\nand email it"),
      entry("assistant", "Q3 it is, and I'll email it."),
    ];
    expect(
      settleSteers(
        [steer("f1", "use Q3"), steer("f2", "and email it")],
        history,
        1,
      ),
    ).toEqual([
      { followUpId: "f1" },
      { followUpId: "f2", reply: "Q3 it is, and I'll email it." },
    ]);
  });

  it("reports a joined steer with no reply, and leaves out what never landed", () => {
    const history = [
      entry("user", "write the report"),
      entry("user", "also check the linter"),
      entry("tool", "linted"),
      entry("assistant", "All passed."),
    ];
    expect(
      settleSteers(
        [steer("f1", "also check the linter"), steer("f2", "never sent")],
        history,
        1,
      ),
    ).toEqual([{ followUpId: "f1" }]);
  });

  it("only reads this turn's window: an earlier turn's identical message does not count", () => {
    // The same words were sent in a PREVIOUS turn and answered there.
    const history = [
      entry("user", "status?"),
      entry("assistant", "All green."),
      entry("user", "deploy it"),
      entry("assistant", "Deploying."),
    ];
    expect(settleSteers([steer("f1", "status?")], history, 2)).toEqual([]);
  });
});
