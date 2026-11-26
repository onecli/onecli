import { describe, expect, it } from "vitest";
import { formatDuration } from "./format-duration";

describe("formatDuration", () => {
  it("rounds to the units a reader acts on", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(-5)).toBe("0m");
    expect(formatDuration(59)).toBe("< 1m");
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(45 * 60 + 30)).toBe("45m");
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(2 * 3600 + 15 * 60)).toBe("2h 15m");
    expect(formatDuration(86_400)).toBe("1d");
    expect(formatDuration(86_400 + 4 * 3600 + 59 * 60)).toBe("1d 4h");
    expect(formatDuration(30 * 86_400)).toBe("30d");
  });
});
