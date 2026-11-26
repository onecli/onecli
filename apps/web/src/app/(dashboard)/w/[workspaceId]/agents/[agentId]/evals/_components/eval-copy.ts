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

/** A filled-in question per check, so the form shows how each one works.
 * Each asks about a closed period, so its expected answer does not drift
 * from day to day, and the custom one states facts the judge can check. */
export const EXAMPLE_QUESTION: Record<
  EvalCheckKind,
  { question: string; expected: string }
> = {
  numeric: {
    question: "How many deals did we close in Q3?",
    expected: "42",
  },
  text: {
    question: "Who is the account owner for Acme Corp?",
    expected: "Dana Levi",
  },
  custom: {
    question: "Summarize the support tickets from September.",
    expected: `The answer should state these facts:
- 120 tickets were opened in September
- The most common issue was failed logins
- Most tickets were resolved within a day

Pass when at least 2 of the 3 facts are present.
Fail if the answer gives a different number of tickets.`,
  },
};

export const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;
