import { describe, expect, it } from "vitest";
import { slotAfterTurns } from "./slot-after-turns";

const turns = [
  { id: "t1", createdAt: "2026-10-08T05:00:00Z" },
  { id: "t2", createdAt: "2026-10-08T05:10:00Z" },
  { id: "t3", createdAt: "2026-10-08T05:20:00Z" },
];
const at = (iso: string) => ({ at: new Date(iso).getTime(), iso });

describe("slotAfterTurns", () => {
  it("slots a card after the last turn that precedes it, in arrival order", () => {
    const first = at("2026-10-08T05:01:00Z");
    const second = at("2026-10-08T05:05:00Z");
    const later = at("2026-10-08T05:11:00Z");
    const { afterTurn, atEnd } = slotAfterTurns(turns, [first, second, later]);
    expect(afterTurn.get("t1")).toEqual([first, second]);
    expect(afterTurn.get("t2")).toEqual([later]);
    expect(atEnd).toEqual([]);
  });

  it("keeps cards from the final exchange (and newer) at the end, never above it", () => {
    const duringLast = at("2026-10-08T05:21:00Z");
    const { afterTurn, atEnd } = slotAfterTurns(turns, [duringLast]);
    expect(afterTurn.size).toBe(0);
    expect(atEnd).toEqual([duringLast]);
  });

  it("puts a card older than every turn, or any card in an empty thread, at the end", () => {
    const early = at("2026-10-08T04:00:00Z");
    expect(slotAfterTurns(turns, [early]).atEnd).toEqual([early]);
    expect(slotAfterTurns([], [early]).atEnd).toEqual([early]);
  });

  it("keeps the final turn's cards in its row when that row is pinned", () => {
    const duringLast = at("2026-10-08T05:21:00Z");
    const { afterTurn, atEnd } = slotAfterTurns(turns, [duringLast], "t3");
    expect(afterTurn.get("t3")).toEqual([duringLast]);
    expect(atEnd).toEqual([]);
  });
});
