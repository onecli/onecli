import { describe, expect, it } from "vitest";
import {
  bulkTitle,
  cellOpOf,
  changeCounts,
  pluralLabel,
  shownValue,
} from "./record-change";

describe("record-change", () => {
  it("counts each row as its riskiest op, riskiest first", () => {
    expect(
      changeCounts([
        { new: ["a"], op: "fill" },
        { new: ["b"], op: "clear" },
        { new: ["c"], op: "fill" },
        { new: ["d"], op: "same" },
      ]),
    ).toEqual([
      { op: "clear", n: 1 },
      { op: "fill", n: 2 },
      { op: "same", n: 1 },
    ]);
  });

  it("claims a fill only for a set value when no op was read", () => {
    expect(cellOpOf({ new: ["x", null] }, 0)).toBe("fill");
    expect(cellOpOf({ new: ["x", null] }, 1)).toBe("untouched");
    expect(cellOpOf({ new: ["x"], ops: ["overwrite"] }, 0)).toBe("overwrite");
  });

  it("says when a value is empty", () => {
    expect(shownValue("")).toBe("empty");
    expect(shownValue(null)).toBe("empty");
    expect(shownValue("Canada")).toBe("Canada");
  });

  it("titles a table as the gateway titles one request's", () => {
    const rows = (n: number) => Array.from({ length: n }, () => ({}));
    expect(bulkTitle({ objectLabel: "Account", rows: rows(9) })).toBe(
      "Update 9 Accounts",
    );
    expect(
      bulkTitle({ kind: "delete", objectLabel: "Opportunity", rows: rows(1) }),
    ).toBe("Delete 1 Opportunity");
  });

  it("pluralizes labels as English, like the gateway's titles", () => {
    for (const [one, many] of [
      ["Contact", "Contacts"],
      ["Opportunity", "Opportunities"],
      ["Deposit batch", "Deposit batches"],
      ["Address", "Addresses"],
      ["Survey", "Surveys"],
    ] as const) {
      expect(pluralLabel(one, 2)).toBe(many);
      expect(pluralLabel(one, 1)).toBe(one);
    }
  });
});
