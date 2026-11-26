import { describe, expect, it } from "vitest";
import {
  asContextSize,
  CONTEXT_FIT_COOLDOWN_MS,
  decideContextSize,
  type ContextFitInput,
} from "./context-fit-rule";

const NOW = new Date("2026-11-03T12:00:00Z");
const longAgo = new Date(NOW.getTime() - CONTEXT_FIT_COOLDOWN_MS - 1);

const decide = (input: Partial<ContextFitInput>) =>
  decideContextSize({
    current: null,
    changedAt: null,
    recentFill: [],
    now: NOW,
    ...input,
  });

const repeat = (fill: number, times: number) =>
  Array.from({ length: times }, () => fill);

describe("decideContextSize", () => {
  it("a new conversation with no evidence stays at the default", () => {
    expect(decide({})).toBeNull();
  });

  describe("growing", () => {
    it("3 of the last 5 turns above 70% of the size grow one rung", () => {
      // 200k default: the bar is 140k.
      expect(
        decide({ recentFill: [150_000, 20_000, 145_000, 30_000, 141_000] }),
      ).toBe(1_000_000);
    });

    it("2 of 5 is not enough, and exactly 70% is not above it", () => {
      expect(
        decide({ recentFill: [170_000, 20_000, 165_000, 30_000, 40_000] }),
      ).toBeNull();
      expect(decide({ recentFill: repeat(140_000, 5) })).toBeNull();
    });

    it("a slow climb grows BEFORE the harness summarizes at 80%", () => {
      // The prompts a real model sent at 200k, one ~7k-token note per turn
      // (live run, jcode p136), newest first. jcode cut the context back to
      // 78k right after the 172k turn; the bar at 80% saw two turns above
      // it, ever. The decision must land while the thread is still whole.
      const observed = [
        157_759, 150_496, 143_248, 135_955, 128_703, 121_423, 114_197,
      ];
      expect(decide({ recentFill: observed })).toBe(1_000_000);
      // One turn earlier it is not yet sustained: no premature move.
      expect(decide({ recentFill: observed.slice(1) })).toBeNull();
    });

    it("needs 5 turns of evidence, however full the few it has", () => {
      expect(decide({ recentFill: repeat(199_000, 4) })).toBeNull();
    });

    it("only the newest 5 count: old pressure does not grow it", () => {
      expect(
        decide({
          recentFill: [...repeat(10_000, 5), ...repeat(190_000, 5)],
        }),
      ).toBeNull();
    });

    it("100k grows to 200k, never straight to 1M", () => {
      expect(
        decide({
          current: 100_000,
          changedAt: longAgo,
          recentFill: repeat(95_000, 5),
        }),
      ).toBe(200_000);
    });

    it("1M is the top: a full 1M conversation stays", () => {
      expect(
        decide({
          current: 1_000_000,
          changedAt: longAgo,
          recentFill: repeat(990_000, 5),
        }),
      ).toBeNull();
    });
  });

  describe("shrinking", () => {
    it("10 turns in a row under half the next smaller size shrink one rung", () => {
      // 200k: the next smaller is 100k, so the bar is 50k.
      expect(decide({ recentFill: repeat(49_000, 10) })).toBe(100_000);
    });

    it("one turn at or over the bar keeps it", () => {
      expect(decide({ recentFill: [...repeat(10_000, 9), 50_000] })).toBeNull();
    });

    it("needs 10 turns of evidence", () => {
      expect(decide({ recentFill: repeat(1_000, 9) })).toBeNull();
    });

    it("1M shrinks to 200k, never straight to 100k", () => {
      expect(
        decide({
          current: 1_000_000,
          changedAt: longAgo,
          recentFill: repeat(1_000, 10),
        }),
      ).toBe(200_000);
    });

    it("100k is the bottom", () => {
      expect(
        decide({
          current: 100_000,
          changedAt: longAgo,
          recentFill: repeat(1_000, 10),
        }),
      ).toBeNull();
    });
  });

  describe("the cooldown", () => {
    it("no change within 30 minutes of the last one, whatever the evidence", () => {
      expect(
        decide({
          current: 1_000_000,
          changedAt: new Date(NOW.getTime() - CONTEXT_FIT_COOLDOWN_MS + 1),
          recentFill: repeat(1_000, 10),
        }),
      ).toBeNull();
    });

    it("changes again once the cooldown has passed", () => {
      expect(
        decide({
          current: 1_000_000,
          changedAt: new Date(NOW.getTime() - CONTEXT_FIT_COOLDOWN_MS),
          recentFill: repeat(1_000, 10),
        }),
      ).toBe(200_000);
    });
  });
});

describe("asContextSize", () => {
  it("keeps ladder sizes and refuses anything else", () => {
    expect(asContextSize(100_000)).toBe(100_000);
    expect(asContextSize(1_000_000)).toBe(1_000_000);
    expect(asContextSize(150_000)).toBeNull();
    expect(asContextSize(null)).toBeNull();
  });
});
