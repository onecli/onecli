import { describe, expect, it } from "vitest";

import { formatCountdown, secondsUntil } from "./use-countdown";

const NOW = Date.parse("2026-10-29T10:00:00Z");

describe("secondsUntil", () => {
  it("counts whole seconds to the deadline", () => {
    expect(secondsUntil("2026-10-29T10:03:00Z", NOW)).toBe(180);
  });

  it("clamps a passed deadline at 0", () => {
    expect(secondsUntil("2026-10-29T09:00:00Z", NOW)).toBe(0);
  });

  it.each([undefined, null, ""])(
    "reads %j as no deadline, not as 0:00",
    (iso) => {
      expect(secondsUntil(iso, NOW)).toBe(Number.POSITIVE_INFINITY);
    },
  );

  it("still reads an unparsable deadline as 0", () => {
    expect(secondsUntil("not-a-date", NOW)).toBe(0);
  });
});

describe("formatCountdown", () => {
  it("formats m:ss", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(65)).toBe("1:05");
  });

  it("reads an infinite countdown as No expiry", () => {
    expect(formatCountdown(Number.POSITIVE_INFINITY)).toBe("No expiry");
  });
});
