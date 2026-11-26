import { describe, expect, it } from "vitest";
import { isProse, LONG_VALUE_CHARS } from "./approval-text";

describe("isProse", () => {
  it("keeps short one-line values inline", () => {
    expect(isProse("sam@example.com")).toBe(false);
    expect(isProse("x".repeat(LONG_VALUE_CHARS))).toBe(false);
  });

  it("reads long or multi-line values as prose", () => {
    expect(isProse("x".repeat(LONG_VALUE_CHARS + 1))).toBe(true);
    for (const br of ["\n", "\r", "\u2028", "\u2029"]) {
      expect(isProse(`a${br}b`)).toBe(true);
    }
  });
});
