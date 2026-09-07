import { describe, expect, it } from "vitest";
import { replyTargetForLink, replyTargetForTurn } from "./targets";

const directLink = { kind: "direct" as const, externalThreadId: "D100" };

describe("reply targets", () => {
  it("addresses a direct link's IM channel, top-level", () => {
    expect(replyTargetForLink(directLink)).toEqual({
      channel: "D100",
      threadTs: null,
    });
  });

  it("splits a group link's <channel>:<ts> into channel and thread", () => {
    expect(
      replyTargetForLink({ kind: "group", externalThreadId: "C55:1699.123" }),
    ).toEqual({ channel: "C55", threadTs: "1699.123" });
  });

  it("survives a group id with no separator by posting top-level", () => {
    expect(
      replyTargetForLink({ kind: "group", externalThreadId: "C55" }),
    ).toEqual({ channel: "C55", threadTs: null });
  });
});

describe("a turn's reply target", () => {
  it("answers a DM thread IN that thread, not at the bottom of the DM", () => {
    // THE BUG THIS FIXES: one direct conversation carries every thread the
    // person opens inside it, so the LINK alone cannot say which one a given
    // turn belongs to — every threaded answer landed top-level.
    // MUTATION-PROOF: use `replyTargetForLink` in the mirror and this fails.
    expect(
      replyTargetForTurn(directLink, { sourceThreadId: "1699.123" }),
    ).toEqual({ channel: "D100", threadTs: "1699.123" });
  });

  it("leaves a top-level DM top-level", () => {
    expect(replyTargetForTurn(directLink, { sourceThreadId: null })).toEqual({
      channel: "D100",
      threadTs: null,
    });
  });

  it("keeps the link's target when the control plane sends no thread", () => {
    // Version skew: an older control plane never sends the field, and the
    // answer must keep going exactly where it used to.
    expect(replyTargetForTurn(directLink, {})).toEqual({
      channel: "D100",
      threadTs: null,
    });
  });

  it("never lets a turn move the answer to another CONVERSATION", () => {
    // The channel always comes from the link. A turn only narrows where in
    // that conversation the answer lands, so a stale or malformed value can
    // misplace a reply inside its own thread — never redirect it elsewhere.
    expect(
      replyTargetForTurn(
        { kind: "group", externalThreadId: "C55:1699.123" },
        { sourceThreadId: "9999.000" },
      ),
    ).toEqual({ channel: "C55", threadTs: "9999.000" });
  });
});
