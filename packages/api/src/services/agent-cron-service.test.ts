import { describe, expect, it } from "vitest";
import { CRON_JITTER_MAX_SECONDS, computeNextFire } from "./agent-cron-service";
import { ServiceError } from "./errors";

/** Jitter pinned to zero — these cases prove the OCCURRENCE math alone. */
const noJitter = () => 0;

/**
 * The schedule math — pure, so pinned as units. Validation is BY
 * CONSTRUCTION (the same croner object that computes occurrences accepts or
 * rejects), and the timezone is validated through Intl upfront because
 * croner only surfaces a bad zone lazily.
 */
describe("computeNextFire", () => {
  it("computes the next occurrence in the schedule's own timezone", () => {
    // 14:00 in London on a BST date is 13:00 UTC — tz math, not string math.
    const next = computeNextFire(
      "0 14 * * *",
      "Europe/London",
      new Date("2026-08-07T00:00:00Z"),
      noJitter,
    );
    expect(next.toISOString()).toBe("2026-08-07T13:00:00.000Z");
  });

  it("advances past the from-point — firing never re-fires the missed slot", () => {
    // Misfire coalescing rests on this: computing from NOW after downtime
    // yields the next FUTURE slot, one late fire, never a backlog.
    const next = computeNextFire(
      "0 14 * * *",
      "UTC",
      new Date("2026-08-07T14:00:01Z"),
      noJitter,
    );
    expect(next.toISOString()).toBe("2026-08-08T14:00:00.000Z");
  });

  it("jitters LATE-ONLY, bounded by the 300s ceiling on a daily schedule", () => {
    const occurrence = Date.parse("2026-08-08T14:00:00.000Z");
    const from = new Date("2026-08-07T14:00:01Z");
    const atZero = computeNextFire("0 14 * * *", "UTC", from, () => 0);
    expect(atZero.getTime()).toBe(occurrence);
    // random → 1 is excluded by Math.random's contract, so the offset is
    // deterministic: floor(0.999999 × 300 000) = 299 999 — pinned EXACTLY,
    // so deleting the jitter (offset 0) fails here, not just the ceiling.
    const atMax = computeNextFire("0 14 * * *", "UTC", from, () => 0.999999);
    expect(atMax.getTime()).toBe(occurrence + 299_999);
    expect(atMax.getTime()).toBeLessThan(
      occurrence + CRON_JITTER_MAX_SECONDS * 1000,
    );
  });

  it("caps jitter at HALF the occurrence gap — a 2-minute schedule never skips a slot", () => {
    // A flat 300s ceiling would jitter an every-2-minutes schedule past 1-2
    // whole occurrences on the healthy path — coalescing is downtime-only.
    const from = new Date("2026-08-07T14:00:01Z");
    const occurrence = Date.parse("2026-08-07T14:02:00.000Z");
    const atMax = computeNextFire("*/2 * * * *", "UTC", from, () => 0.999999);
    // floor(0.999999 × 60 000) = 59 999: exactly half the 120s gap minus the
    // random exclusion — pinned so a deleted gap-cap OR deleted jitter fails.
    expect(atMax.getTime()).toBe(occurrence + 59_999);
  });

  it("a one-shot schedule (no following occurrence) takes the full ceiling", () => {
    // croner accepts an ISO datetime as a one-shot pattern; with no following
    // occurrence the gap is unbounded and the 300s ceiling alone applies.
    const occurrence = Date.parse("2026-12-01T09:00:00.000Z");
    const atMax = computeNextFire(
      "2026-12-01T09:00:00",
      "UTC",
      new Date("2026-08-07T00:00:00Z"),
      () => 0.999999,
    );
    expect(atMax.getTime()).toBe(occurrence + 299_999);
  });

  it("rejects an invalid expression with the engine's own words", () => {
    expect(() =>
      computeNextFire("99 99 * * *", "UTC", new Date()),
    ).toThrowError(ServiceError);
    expect(() => computeNextFire("99 99 * * *", "UTC", new Date())).toThrow(
      /Invalid schedule expression/,
    );
  });

  it("rejects an unknown timezone upfront — croner would only fail lazily", () => {
    expect(() => computeNextFire("0 9 * * *", "Not/AZone", new Date())).toThrow(
      /Unknown timezone/,
    );
  });
});
