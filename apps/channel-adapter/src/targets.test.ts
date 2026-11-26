import { unpackThreadAddress } from "@onecli/channels/slack";
import { describe, expect, it } from "vitest";
import { replyTargetForLink, replyTargetForTurn } from "./targets";

/** A DM's TOP LEVEL: the bare IM id (the person's one direct conversation). */
const directLink = { externalThreadId: "D100" };

describe("reply targets", () => {
  it("addresses a top-level DM link at the IM channel itself", () => {
    expect(replyTargetForLink(unpackThreadAddress, directLink)).toEqual({
      channel: "D100",
      threadTs: null,
    });
  });

  it("addresses a DM THREAD's link inside its thread", () => {
    // A thread opened inside a DM is a conversation of its own, linked
    // `direct` (the IM is where replies post) under the thread's packed
    // address. Everything that posts by the LINK alone (approval cards, the
    // narration card, a turn with no source thread) must land in the
    // thread, never at the bottom of the DM. MUTATION-PROOF: make the
    // decoder read the bare id for `direct` links again and this fails.
    expect(
      replyTargetForLink(unpackThreadAddress, {
        externalThreadId: "D100:1699.123",
      }),
    ).toEqual({ channel: "D100", threadTs: "1699.123" });
  });

  it("splits a group link's <channel>:<ts> into channel and thread", () => {
    expect(
      replyTargetForLink(unpackThreadAddress, {
        externalThreadId: "C55:1699.123",
      }),
    ).toEqual({ channel: "C55", threadTs: "1699.123" });
  });

  it("survives a group id with no separator by posting top-level", () => {
    expect(
      replyTargetForLink(unpackThreadAddress, {
        externalThreadId: "C55",
      }),
    ).toEqual({ channel: "C55", threadTs: null });
  });
});

describe("a turn's reply target", () => {
  it("answers a DM thread IN that thread, not at the bottom of the DM", () => {
    // THE BUG THIS FIXES: the DM's top-level link carries every turn typed
    // at the bottom of the DM, so the LINK alone cannot say which thread a
    // given turn belongs to — every threaded answer landed top-level.
    // MUTATION-PROOF: use `replyTargetForLink` in the mirror and this fails.
    expect(
      replyTargetForTurn(unpackThreadAddress, directLink, {
        sourceThreadId: "1699.123",
      }),
    ).toEqual({ channel: "D100", threadTs: "1699.123" });
  });

  it("leaves a top-level DM top-level", () => {
    expect(
      replyTargetForTurn(unpackThreadAddress, directLink, {
        sourceThreadId: null,
      }),
    ).toEqual({
      channel: "D100",
      threadTs: null,
    });
  });

  it("keeps the link's target when the control plane sends no thread", () => {
    // Version skew: an older control plane never sends the field, and the
    // answer must keep going exactly where it used to.
    expect(replyTargetForTurn(unpackThreadAddress, directLink, {})).toEqual({
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
        unpackThreadAddress,
        { externalThreadId: "C55:1699.123" },
        { sourceThreadId: "9999.000" },
      ),
    ).toEqual({ channel: "C55", threadTs: "9999.000" });
  });
});
