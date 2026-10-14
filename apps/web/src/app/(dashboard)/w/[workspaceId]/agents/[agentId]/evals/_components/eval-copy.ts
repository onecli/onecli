import type { EvalCheckKind, EvalOutcome } from "@onecli/api/validations/evals";

/**
 * The words the Evals screen uses, in one place so the vocabulary stays
 * consistent: a "test question" is checked by a "number check", a
 * "keyword check" or a "custom check" (an AI judge applying the author's own
 * success criteria), and each result has one outcome.
 */

export const CHECK_LABEL: Record<EvalCheckKind, string> = {
  numeric: "Number check",
  text: "Keyword check",
  custom: "Custom check",
};

export const OUTCOME_LABEL: Record<EvalOutcome, string> = {
  passed: "Passed",
  mismatch: "Mismatch",
  error: "Did not finish",
  inconclusive: "Inconclusive",
  pending: "Waiting",
};

/** A starting point for custom success criteria: facts, then the rule. */
export const CRITERIA_TEMPLATE = `The answer should state these facts:
- <fact 1>
- <fact 2>
- <fact 3>

Pass when at least 70% of the facts are present.
Fail if the answer states anything that contradicts these facts.`;

export const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;
