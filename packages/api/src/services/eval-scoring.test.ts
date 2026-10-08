import { describe, expect, it } from "vitest";
import { numbersIn, parseNumericExpected } from "../validations/evals";
import { numericMatch, scoreEval, textMatch } from "./eval-scoring";

describe("number parsing", () => {
  it.each(["42", "$3.2M", "3,200,000", "42%", "-42", "-$42", "+42"])(
    "accepts the single number %s",
    (value) => {
      expect(parseNumericExpected(value)).not.toBeNull();
    },
  );

  it.each([
    "Q1 2026 was 42",
    "2026-09-20",
    "42 and 43",
    "1,23",
    "NaN",
    "Infinity",
    "1e309",
    "9".repeat(400),
    "",
    "42 customers",
  ])("rejects %s, which is not one number", (value) => {
    expect(parseNumericExpected(value)).toBeNull();
    expect(numericMatch("42", value)).toBe(false);
  });

  it("keeps a negative currency sign", () => {
    expect(parseNumericExpected("-$42")).toBe(-42);
  });

  it("reads numbers with separators and scale words", () => {
    expect(numbersIn("Q1 2026 revenue was $3.2M")).toEqual([1, 2026, 3.2e6]);
    expect(numbersIn("3,200,000 USD")).toEqual([3_200_000]);
    expect(numbersIn("about 1.5 billion")).toEqual([1.5e9]);
    expect(numbersIn("42k users")).toEqual([42_000]);
  });
});

describe("answer checks", () => {
  it("number: any stated number within 0.5% matches", () => {
    expect(numericMatch("Q1 2026 revenue was $3.2M", "3200000")).toBe(true);
    expect(numericMatch("Revenue: 3,200,000 USD in 2026", "3200000")).toBe(
      true,
    );
    expect(numericMatch("We have 42 customers", "42")).toBe(true);
    expect(numericMatch("I think around 40", "42")).toBe(false);
    expect(numericMatch("no figure here", "42")).toBe(false);
  });

  it("keywords: every significant expected word must appear", () => {
    expect(
      textMatch(
        "Acme is in RENEWAL; last call was 2026-09-20.",
        "Acme renewal",
      ),
    ).toBe(true);
    expect(textMatch("Acme churned last month", "Acme renewal")).toBe(false);
    expect(textMatch("anything", "the a")).toBe(false);
  });
});

describe("scoreEval", () => {
  const numeric = { expected: "42", kind: "numeric" as const };
  const done = { answer: "We have 42", error: null, appsUsed: [] };

  it("passes a correct answer with no required apps", () => {
    expect(scoreEval({ ...numeric, expectedApps: [] }, done)).toEqual({
      outcome: "passed",
      missingApps: null,
    });
  });

  it("is a mismatch when the answer check fails", () => {
    expect(
      scoreEval({ ...numeric, expectedApps: [] }, { ...done, answer: "41" }),
    ).toEqual({ outcome: "mismatch", missingApps: null });
  });

  it("is a mismatch, naming the missing apps, case-insensitively", () => {
    expect(
      scoreEval(
        { ...numeric, expectedApps: ["Example-App", "other-app"] },
        { ...done, appsUsed: ["example-app"] },
      ),
    ).toEqual({ outcome: "mismatch", missingApps: ["other-app"] });
  });

  it("passes when every required app was reached", () => {
    expect(
      scoreEval(
        { ...numeric, expectedApps: ["example-app"] },
        { ...done, appsUsed: ["example-app", "extra-app"] },
      ),
    ).toEqual({ outcome: "passed", missingApps: [] });
  });

  it("is inconclusive, not missing, when a correct answer has no app evidence", () => {
    expect(
      scoreEval(
        { ...numeric, expectedApps: ["example-app"] },
        { ...done, appsUsed: null },
      ),
    ).toEqual({ outcome: "inconclusive", missingApps: null });
  });

  it("is still a mismatch when the answer is wrong, whatever the app evidence", () => {
    expect(
      scoreEval(
        { ...numeric, expectedApps: ["example-app"] },
        { answer: "41", error: null, appsUsed: null },
      ),
    ).toEqual({ outcome: "mismatch", missingApps: null });
  });

  it.each([
    { answer: "42", error: "Failed" },
    { answer: null, error: null },
  ])(
    "is an error, never a pass, for an unfinished turn (%o)",
    ({ answer, error }) => {
      expect(
        scoreEval(
          { ...numeric, expectedApps: [] },
          { answer, error, appsUsed: [] },
        ),
      ).toEqual({ outcome: "error", missingApps: null });
    },
  );
});
