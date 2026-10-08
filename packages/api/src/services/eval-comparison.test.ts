import { describe, expect, it } from "vitest";
import type { EvalResult } from "../validations/evals";
import { compareToPrevious } from "./eval-comparison";

const result = (patch: Partial<EvalResult> = {}): EvalResult => ({
  questionId: "q1",
  question: "How many?",
  expected: "42",
  kind: "numeric",
  expectedApps: ["a", "b"],
  outcome: "passed",
  answer: "42",
  missingApps: [],
  turnId: "t",
  conversationId: "c",
  error: null,
  ...patch,
});

const changeOf = (now: EvalResult, before: EvalResult | null) =>
  compareToPrevious([now], before ? [before] : [])[0]?.change;

describe("compareToPrevious", () => {
  it("has no change at all without a previous run", () => {
    expect(compareToPrevious([result()], null)[0]?.change).toBeNull();
  });

  it.each([
    ["passed", "passed", "same"],
    ["mismatch", "error", "same"],
    ["passed", "mismatch", "regressed"],
    ["passed", "error", "regressed"],
    ["mismatch", "passed", "fixed"],
  ] as const)("%s then %s is %s", (before, now, change) => {
    expect(
      changeOf(result({ outcome: now }), result({ outcome: before })),
    ).toBe(change);
  });

  it("compares required apps in any order", () => {
    expect(
      changeOf(
        result({ outcome: "mismatch" }),
        result({ expectedApps: ["b", "a"] }),
      ),
    ).toBe("regressed");
  });

  it.each([
    { question: "How many now?" },
    { expected: "43" },
    { kind: "text" as const },
    { expectedApps: ["a"] },
  ])("treats an edited question as new (%o)", (edit) => {
    expect(changeOf(result(), result(edit))).toBe("new");
  });

  it("treats a question missing from the previous run as new", () => {
    expect(changeOf(result(), null)).toBe("new");
  });

  it("gives no change to a result without a verdict on either side", () => {
    expect(changeOf(result({ outcome: "inconclusive" }), result())).toBeNull();
    expect(changeOf(result({ outcome: "pending" }), result())).toBeNull();
    expect(changeOf(result(), result({ outcome: "inconclusive" }))).toBeNull();
  });
});
