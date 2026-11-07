import { describe, expect, it } from "vitest";

import { isValidTimezone, sandboxTimezoneSchema } from "./timezone";

const accepts = (tz: string) => sandboxTimezoneSchema.safeParse(tz).success;

describe("isValidTimezone", () => {
  it("resolves what this runtime's Intl resolves: aliases, short ids, any case", () => {
    for (const tz of [
      "America/Los_Angeles",
      "Europe/Kyiv",
      "Etc/UTC",
      "PST",
      "america/new_york",
    ]) {
      expect(isValidTimezone(tz), tz).toBe(true);
    }
  });

  it("rejects nonsense", () => {
    for (const tz of ["Mars/Olympus", "", "GMT+3"]) {
      expect(isValidTimezone(tz), tz).toBe(false);
    }
  });
});

describe("sandboxTimezoneSchema", () => {
  it("accepts every zone the settings dropdown can offer", () => {
    // The dropdown is built from this list; a rejected entry would be a
    // choice the user can make and the API refuses.
    for (const tz of Intl.supportedValuesOf("timeZone")) {
      expect(accepts(tz), tz).toBe(true);
    }
    expect(accepts("UTC")).toBe(true);
  });

  it("accepts legacy spellings the sandbox's tzdata-legacy ships", () => {
    for (const tz of [
      "Asia/Calcutta",
      "Europe/Kiev",
      "US/Pacific",
      "Etc/GMT-3",
    ]) {
      expect(accepts(tz), tz).toBe(true);
    }
  });

  it("rejects short ids Intl resolves but no tzdata ships as a file", () => {
    // libc would keep UTC for these without a word: the silent-wrong-clock
    // case the file-shape rule exists for.
    for (const tz of ["PST", "EST5EDT", "Zulu", "GMT", "Japan", "Israel"]) {
      expect(accepts(tz), tz).toBe(false);
    }
  });

  it("rejects Area/Location names that are not zone files, letter case included", () => {
    // Intl resolves `america/new_york`; libc looks for that exact file and
    // finds nothing.
    for (const tz of [
      "SystemV/PST8",
      "US/Pacific-New",
      "Canada/East-Saskatchewan",
      "Mars/Olympus",
      "America/Nowhere",
      "america/new_york",
    ]) {
      expect(accepts(tz), tz).toBe(false);
    }
  });

  it("rejects shapes that could never be a file name", () => {
    for (const tz of ["", "  ", "../etc/passwd", "America/../Etc", "+03:00"]) {
      expect(accepts(tz), JSON.stringify(tz)).toBe(false);
    }
    expect(accepts(`America/${"x".repeat(100)}`)).toBe(false);
  });

  it("trims surrounding whitespace", () => {
    const parsed = sandboxTimezoneSchema.safeParse("  Asia/Jerusalem ");
    expect(parsed.success && parsed.data).toBe("Asia/Jerusalem");
  });
});
