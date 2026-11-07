import { describe, expect, it } from "vitest";
import { formatRequestedAt, formatRequestedAtFull } from "./requested-at";

const now = new Date(2026, 9, 27, 16, 0, 0).getTime();
const ago = (ms: number) => new Date(now - ms).toISOString();

describe("formatRequestedAt", () => {
  it("is relative while fresh", () => {
    expect(formatRequestedAt(ago(5_000), now)).toBe("just now");
    expect(formatRequestedAt(ago(2 * 60_000), now)).toBe("2m ago");
    expect(formatRequestedAt(ago(3 * 3_600_000), now)).toBe("3h ago");
    expect(formatRequestedAt(ago(23 * 3_600_000 + 59 * 60_000), now)).toBe(
      "23h ago",
    );
  });

  it("a future stamp (clock skew) reads just now", () => {
    expect(formatRequestedAt(ago(-30_000), now)).toBe("just now");
  });

  it("shows the date and time once a day old; the year only when it differs", () => {
    const old = new Date(2026, 9, 25, 14, 6).toISOString();
    expect(formatRequestedAt(old, now)).toBe("Oct 25, 14:06");
    const lastYear = new Date(2025, 11, 31, 9, 5).toISOString();
    expect(formatRequestedAt(lastYear, now)).toBe("Dec 31, 2025, 09:05");
  });

  it("the tooltip carries the full timestamp", () => {
    const at = new Date(2026, 9, 27, 13, 26, 7).toISOString();
    expect(formatRequestedAtFull(at)).toBe("Tue, Oct 27, 2026, 13:26:07");
  });
});
