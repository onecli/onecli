import { describe, expect, it } from "vitest";
import { isReply } from "./reply";

describe("isReply", () => {
  it("accepts the two shapes the daemon sends", () => {
    expect(isReply({ ok: true, url: "u", title: "t" })).toBe(true);
    expect(
      isReply({ ok: true, url: "u", title: "t", snapshot: "e1 link" }),
    ).toBe(true);
    expect(isReply({ ok: false, error: "nope" })).toBe(true);
  });

  it("refuses anything else, so a bad line is one clear error and not a crash", () => {
    for (const bad of [
      null,
      undefined,
      "ok",
      1,
      {},
      { ok: true },
      { ok: false },
      { ok: "yes", url: "u", title: "t" },
    ]) {
      expect(isReply(bad)).toBe(false);
    }
  });
});
