import { describe, expect, it } from "vitest";
import { buildReorderIds } from "./build-reorder-ids";

// The full-permutation rebuild the drag UI feeds to PUT /rules/order: custom
// positions are slots filled from the new custom order; derived + equipment
// rows never move. The route separately validates the result names every
// non-default draft rule exactly once — these tests pin the client-side half.

const row = (id: string, source: string) => ({ id, source });

describe("buildReorderIds", () => {
  it("fills custom slots in the new order and keeps other rows fixed", () => {
    const full = [
      row("c1", "custom"),
      row("d1", "blocklist"),
      row("c2", "custom"),
      row("e1", "equipment"),
      row("c3", "custom"),
    ];

    expect(buildReorderIds(full, ["c3", "c1", "c2"])).toEqual([
      "c3",
      "d1",
      "c1",
      "e1",
      "c2",
    ]);
  });

  it("is the identity when the custom order is unchanged", () => {
    const full = [
      row("d1", "app_permission"),
      row("c1", "custom"),
      row("c2", "custom"),
    ];

    expect(buildReorderIds(full, ["c1", "c2"])).toEqual(["d1", "c1", "c2"]);
  });

  it("permutes freely when every rule is custom", () => {
    const full = [row("a", "custom"), row("b", "custom"), row("c", "custom")];

    expect(buildReorderIds(full, ["b", "c", "a"])).toEqual(["b", "c", "a"]);
  });

  it("returns the list untouched when there are no custom rules", () => {
    const full = [row("d1", "blocklist"), row("e1", "equipment")];

    expect(buildReorderIds(full, [])).toEqual(["d1", "e1"]);
  });

  it("throws when the custom order misses a rule", () => {
    const full = [row("c1", "custom"), row("c2", "custom")];

    expect(() => buildReorderIds(full, ["c1"])).toThrow(/exactly once/);
  });

  it("throws when the custom order names a duplicate", () => {
    const full = [row("c1", "custom"), row("c2", "custom")];

    expect(() => buildReorderIds(full, ["c1", "c1"])).toThrow(/exactly once/);
  });

  it("throws when the custom order names a foreign id", () => {
    const full = [row("c1", "custom"), row("c2", "custom")];

    expect(() => buildReorderIds(full, ["c1", "other"])).toThrow(
      /exactly once/,
    );
  });
});
