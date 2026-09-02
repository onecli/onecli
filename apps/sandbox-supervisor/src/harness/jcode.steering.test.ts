import { describe, expect, it } from "vitest";
import { matchJoinedSteers } from "./jcode";

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

  it("matches an injected message", () => {
    expect(
      matchJoinedSteers(
        [steer("a", "also include tests")],
        ["also include tests"],
      ),
    ).toEqual(["a"]);
  });

  it("matches a MULTI-PARAGRAPH steer whole — never split on the group separator", () => {
    const message = "first paragraph\n\nsecond paragraph";
    expect(matchJoinedSteers([steer("a", message)], [message])).toEqual(["a"]);
  });

  it("matches every member of a grouped injection", () => {
    // Two steers drained together arrive as ONE user entry, joined by \n\n.
    expect(
      matchJoinedSteers(
        [steer("a", "do x"), steer("b", "do y")],
        ["do x\n\ndo y"],
      ).sort(),
    ).toEqual(["a", "b"]);
  });

  it("misses what was never injected", () => {
    expect(
      matchJoinedSteers(
        [steer("a", "injected"), steer("b", "dropped")],
        ["injected"],
      ),
    ).toEqual(["a"]);
  });

  it("never matches ACROSS entry boundaries — one steer lands in one entry", () => {
    // MUTATION-PROOF for per-entry matching: a blob join("\n\n") would make
    // the boundary between two separate injections indistinguishable from an
    // in-entry group separator, and "a\n\nb" would falsely settle joined —
    // the message silently swallowed while the real a and b re-run.
    expect(matchJoinedSteers([steer("x", "a\n\nb")], ["a", "b"])).toEqual([]);
    expect(
      matchJoinedSteers(
        [steer("a", "a"), steer("b", "b"), steer("x", "a\n\nb")],
        ["a", "b"],
      ).sort(),
    ).toEqual(["a", "b"]);
  });

  it("consumes spans longest-first so overlapping steers never double-claim", () => {
    // "a" is a substring of "abc": if "a" matched first it would claim the
    // span "abc" occupies and BOTH would read joined off one injection.
    const joined = matchJoinedSteers(
      [steer("short", "a"), steer("long", "abc")],
      ["abc"],
    );
    expect(joined).toEqual(["long"]);
  });

  it("counts duplicate messages once per injected copy", () => {
    expect(
      matchJoinedSteers(
        [steer("first", "ok"), steer("second", "ok")],
        ["ok\n\nok"],
      ).sort(),
    ).toEqual(["first", "second"]);
    expect(
      matchJoinedSteers([steer("first", "ok"), steer("second", "ok")], ["ok"]),
    ).toHaveLength(1);
  });

  it("never matches an empty message", () => {
    expect(matchJoinedSteers([steer("a", "")], ["anything"])).toEqual([]);
  });

  it("answers nothing for no candidates — everything missed, promotion runs it", () => {
    expect(matchJoinedSteers([steer("a", "hello")], [])).toEqual([]);
  });
});
