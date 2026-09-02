import { describe, expect, it } from "vitest";
import { replyTargetForLink } from "./targets";

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
