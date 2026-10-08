import {
  numbersIn,
  parseNumericExpected,
  type EvalCheckKind,
  type EvalOutcome,
} from "../validations/evals";

/**
 * Eval SCORING: how one answer is judged. Deliberately simple and
 * explainable baselines, not semantic judging: a number check and a keyword
 * check, plus the required apps from the gateway evidence.
 */

/** Number check: ANY number stated in the answer within 0.5% of the target. */
export const numericMatch = (answer: string, expected: string): boolean => {
  const target = parseNumericExpected(expected);
  if (target === null) return false;
  const tolerance = Math.max(Math.abs(target) * 0.005, 1e-9);
  return numbersIn(answer).some((n) => Math.abs(n - target) <= tolerance);
};

const STOP_WORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "is",
  "in",
  "of",
  "and",
  "to",
  "on",
]);

const words = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/);

/** Keyword check: every significant expected word appears in the answer.
 * Words, not meaning: negation and paraphrase are not understood. */
export const textMatch = (answer: string, expected: string): boolean => {
  const wanted = words(expected).filter(
    (w) => w.length > 1 && !STOP_WORDS.has(w),
  );
  if (wanted.length === 0) return false;
  const have = new Set(words(answer));
  return wanted.every((w) => have.has(w));
};

/** What one answer is scored on. */
interface ScoringEvidence {
  /** The agent's final answer, or null when it gave none. */
  answer: string | null;
  /** Why the turn did not complete, or null when it did. */
  error: string | null;
  /** Provider IDs and matched `host:` tokens the agent reached, or null when
   * app evidence was unavailable (ambiguous or partial). */
  appsUsed: string[] | null;
}

/**
 * Score one question from its evidence. An unfinished turn is an `error`,
 * never a pass on a partial answer. Required apps are checked only when the
 * evidence exists; a correct answer with unknown app evidence is
 * `inconclusive`, never a pass and never a "missing app".
 */
export const scoreEval = (
  check: { expected: string; kind: EvalCheckKind; expectedApps: string[] },
  evidence: ScoringEvidence,
): { outcome: EvalOutcome; missingApps: string[] | null } => {
  if (evidence.error !== null || evidence.answer === null)
    return { outcome: "error", missingApps: null };
  const answerOk =
    check.kind === "numeric"
      ? numericMatch(evidence.answer, check.expected)
      : textMatch(evidence.answer, check.expected);
  if (check.expectedApps.length === 0)
    return { outcome: answerOk ? "passed" : "mismatch", missingApps: null };
  if (evidence.appsUsed === null)
    return {
      outcome: answerOk ? "inconclusive" : "mismatch",
      missingApps: null,
    };
  const used = new Set(evidence.appsUsed.map((a) => a.toLowerCase()));
  const missingApps = check.expectedApps.filter(
    (app) => !used.has(app.toLowerCase()),
  );
  return {
    outcome: answerOk && missingApps.length === 0 ? "passed" : "mismatch",
    missingApps,
  };
};
