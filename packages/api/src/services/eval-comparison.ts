import type {
  EvalChange,
  EvalResult,
  EvalResultView,
} from "../validations/evals";

/**
 * Compare a run's results with the previous completed run of the same agent.
 * Only an identical question is compared: same text, expected answer, check
 * and required apps (in any order). A result without a verdict on either
 * side (pending, inconclusive) has nothing to compare, so its change is null.
 */

const sameCheck = (a: EvalResult, b: EvalResult) => {
  if (
    a.question !== b.question ||
    a.expected !== b.expected ||
    a.kind !== b.kind ||
    a.expectedApps.length !== b.expectedApps.length
  )
    return false;
  const apps = new Set(a.expectedApps);
  return b.expectedApps.every((app) => apps.has(app));
};

const VERDICTS = new Set<EvalResult["outcome"]>([
  "passed",
  "mismatch",
  "error",
]);

const changeOf = (
  result: EvalResult,
  before: EvalResult | undefined,
): EvalChange | null => {
  if (!VERDICTS.has(result.outcome)) return null;
  if (!before || !sameCheck(result, before)) return "new";
  // An unchanged question that had no verdict last time has nothing to
  // compare with, and it is not new either.
  if (!VERDICTS.has(before.outcome)) return null;
  const passedBefore = before.outcome === "passed";
  const passedNow = result.outcome === "passed";
  if (passedBefore === passedNow) return "same";
  return passedNow ? "fixed" : "regressed";
};

export const compareToPrevious = (
  results: EvalResult[],
  previous: EvalResult[] | null,
): EvalResultView[] => {
  const before = new Map(previous?.map((r) => [r.questionId, r]));
  return results.map((result) => ({
    ...result,
    change: previous ? changeOf(result, before.get(result.questionId)) : null,
  }));
};
