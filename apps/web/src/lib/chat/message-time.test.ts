// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The time a chat message shows. Run in a fixed zone and locale so the
 * strings are stable here; in the browser they follow the viewer's own.
 */
describe("formatMessageTime", () => {
  let formatMessageTime: (iso: string, now: Date) => string;
  let formatMessageTimeLong: (iso: string) => string;

  beforeAll(async () => {
    vi.stubEnv("TZ", "Asia/Jerusalem");
    ({ formatMessageTime, formatMessageTimeLong } =
      await import("./message-time"));
  });
  afterAll(() => vi.unstubAllEnvs());

  // 2026-11-08 18:30 in Jerusalem (UTC+2).
  const now = new Date("2026-11-08T16:30:00Z");

  it("shows only the time for today, in the viewer's zone", () => {
    // 15:16 UTC is 17:16 in Jerusalem.
    expect(formatMessageTime("2026-11-08T15:16:00Z", now)).toMatch(
      /^5:16\s?PM$/,
    );
  });

  it("uses the viewer's calendar day, not UTC's", () => {
    // 23:30 UTC on the 7th is 01:30 on the 8th in Jerusalem: today.
    expect(formatMessageTime("2026-11-07T23:30:00Z", now)).toMatch(
      /^1:30\s?AM$/,
    );
  });

  it("says yesterday for the day before", () => {
    expect(formatMessageTime("2026-11-07T10:00:00Z", now)).toMatch(
      /^Yesterday, 12:00\s?PM$/,
    );
  });

  it("adds the date earlier this year, and the year before that", () => {
    expect(formatMessageTime("2026-03-02T10:00:00Z", now)).toMatch(
      /^Mar 2, 12:00\s?PM$/,
    );
    expect(formatMessageTime("2025-11-07T10:00:00Z", now)).toMatch(
      /^Nov 7, 2025, 12:00\s?PM$/,
    );
  });

  it("renders nothing for an unparseable time", () => {
    expect(formatMessageTime("not a date", now)).toBe("");
    expect(formatMessageTimeLong("not a date")).toBe("");
  });

  it("spells the full date out for the tooltip", () => {
    expect(formatMessageTimeLong("2026-11-08T15:16:00Z")).toMatch(
      /Sunday, November 8, 2026.*5:16\s?PM/,
    );
  });
});
