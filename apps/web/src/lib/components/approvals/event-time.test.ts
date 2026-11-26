import { describe, expect, it } from "vitest";
import { formatEventWhen, parseEventTime } from "./event-time";

describe("formatEventWhen", () => {
  it("same-day timed event in the request's own zone", () => {
    expect(
      formatEventWhen("2026-10-01T10:00:00+03:00", "2026-10-01T11:30:00+03:00"),
    ).toBe("Thu, Oct 1, 2026 · 10:00 – 11:30 (GMT+3)");
    expect(
      formatEventWhen("2026-10-01T10:00:00Z", "2026-10-01T11:00:00Z"),
    ).toBe("Thu, Oct 1, 2026 · 10:00 – 11:00 (UTC)");
  });

  it("keeps an Outlook zone name as written", () => {
    expect(
      formatEventWhen(
        "2026-06-20T15:00:00 (Pacific Standard Time)",
        "2026-06-20T16:00:00 (Pacific Standard Time)",
      ),
    ).toBe("Sat, Jun 20, 2026 · 15:00 – 16:00 (Pacific Standard Time)");
  });

  it("multi-day timed event", () => {
    expect(
      formatEventWhen("2026-10-01T22:00:00Z", "2026-10-02T01:00:00Z"),
    ).toBe("Thu, Oct 1, 22:00 (UTC) → Fri, Oct 2, 2026, 01:00");
    // A different end zone is spelled out.
    expect(
      formatEventWhen("2026-10-01T22:00:00Z", "2026-10-02T04:00:00+03:00"),
    ).toBe("Thu, Oct 1, 22:00 (UTC) → Fri, Oct 2, 2026, 04:00 (GMT+3)");
  });

  it("all-day events treat Google's end date as exclusive", () => {
    expect(formatEventWhen("2026-10-01", "2026-10-02")).toBe(
      "Thu, Oct 1, 2026 · All day",
    );
    expect(formatEventWhen("2026-10-01", "2026-10-04")).toBe(
      "Thu, Oct 1 – Sat, Oct 3, 2026 · All day",
    );
  });

  it("never converts to the viewer's zone", () => {
    // 23:30 at +14:00 is still "Oct 1, 23:30" on the event itself.
    expect(parseEventTime("2026-10-01T23:30:00+14:00")).toEqual({
      y: 2026,
      m: 10,
      d: 1,
      time: "23:30",
      zone: "GMT+14",
    });
  });

  it("falls back to the raw strings when unrecognized", () => {
    expect(formatEventWhen("next tuesday", "later")).toBe(
      "next tuesday → later",
    );
  });
});
