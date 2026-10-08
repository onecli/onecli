import type { EvalCheckKind, EvalOutcome } from "@onecli/api/validations/evals";

/**
 * The words the Evals screen uses, in one place so the vocabulary stays
 * consistent: a "test question" is checked by a "number check" or a
 * "keyword check", and each result has one outcome.
 */

export const CHECK_LABEL: Record<EvalCheckKind, string> = {
  numeric: "Number check",
  text: "Keyword check",
};

export const OUTCOME_LABEL: Record<EvalOutcome, string> = {
  passed: "Passed",
  mismatch: "Mismatch",
  error: "Did not finish",
  inconclusive: "Inconclusive",
  pending: "Waiting",
};

export const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;
