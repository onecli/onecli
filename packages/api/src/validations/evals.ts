import { z } from "zod";

/**
 * Agent EVALS: the test-question contract and the pure answer checks.
 *
 * One definition shared by the API (route validation, scoring) and the
 * dashboard (the question form validates against the same rules before it
 * submits). Pure on purpose: no database, no server-only imports, so the
 * browser bundle can import it.
 */

/** Active test questions one agent may have. */
export const EVAL_QUESTIONS_MAX = 50;
/** Longest question or expected answer, in characters. */
export const EVAL_TEXT_MAX_LENGTH = 4_000;
/** Apps one question may require. */
export const EVAL_APPS_MAX = 20;
/** Longest app ID: a catalog provider ID or a `host:` token. */
export const EVAL_APP_ID_MAX_LENGTH = 100;
/** Runs the dashboard lists, newest first. */
export const EVAL_RUNS_LISTED = 30;

/** How an answer is checked. */
export const EVAL_CHECK_KINDS = ["numeric", "text"] as const;
export type EvalCheckKind = (typeof EVAL_CHECK_KINDS)[number];

/** A run's lifecycle. Only `queued` and `running` occupy the agent. */
export const EVAL_RUN_STATUSES = [
  "queued",
  "running",
  "done",
  "failed",
] as const;
export type EvalRunStatus = (typeof EVAL_RUN_STATUSES)[number];
export const ACTIVE_EVAL_RUN_STATUSES = [
  "queued",
  "running",
] as const satisfies readonly EvalRunStatus[];
export const isActiveEvalRun = (status: EvalRunStatus): boolean =>
  ACTIVE_EVAL_RUN_STATUSES.some((active) => active === status);

/**
 * One question's outcome in a run, decided once by the API:
 * - `pending`: still being asked;
 * - `passed`: the answer check passed and every required app was reached;
 * - `mismatch`: the answer check failed, or a required app was not reached;
 * - `error`: the agent did not finish the turn (failed, stopped, timed out);
 * - `inconclusive`: the answer passed but app evidence was unavailable, so
 *   the required apps could not be checked either way.
 */
export const EVAL_OUTCOMES = [
  "pending",
  "passed",
  "mismatch",
  "error",
  "inconclusive",
] as const;
export type EvalOutcome = (typeof EVAL_OUTCOMES)[number];

/** One question's result, as stored on the run and returned on the wire.
 * It snapshots the question, so history survives later edits. */
export const evalResultSchema = z.object({
  questionId: z.string(),
  question: z.string(),
  expected: z.string(),
  kind: z.enum(EVAL_CHECK_KINDS),
  expectedApps: z.array(z.string()),
  outcome: z.enum(EVAL_OUTCOMES),
  answer: z.string().nullable(),
  /** Required apps not reached; null when apps were not checked. */
  missingApps: z.array(z.string()).nullable(),
  turnId: z.string().nullable(),
  conversationId: z.string().nullable(),
  /** Why an `error` outcome happened. */
  error: z.string().nullable(),
});
export type EvalResult = z.infer<typeof evalResultSchema>;

/**
 * How a result compares with the same question in the previous completed
 * run. Only an identical question (same text, expected answer, check and
 * apps) is compared; anything else is `new`.
 * - `new`: no comparable result in the previous run (new or edited);
 * - `same`: the outcome did not change;
 * - `fixed`: it did not pass before and passes now;
 * - `regressed`: it passed before and does not pass now.
 */
export type EvalChange = "new" | "same" | "fixed" | "regressed";

/** A result as the dashboard reads it: the stored result plus its change. */
export type EvalResultView = EvalResult & { change: EvalChange | null };

export type EvalOutcomeCounts = Record<EvalOutcome, number>;

/** Outcome counts for a run. Questions not asked yet count as pending. */
export const countEvalOutcomes = (
  results: readonly Pick<EvalResult, "outcome">[],
  total: number,
): EvalOutcomeCounts => {
  const counts: EvalOutcomeCounts = {
    pending: Math.max(0, total - results.length),
    passed: 0,
    mismatch: 0,
    error: 0,
    inconclusive: 0,
  };
  for (const { outcome } of results) counts[outcome] += 1;
  return counts;
};

/** A custom app is required by its exact host: `host:api.example.com`. */
export const EVAL_HOST_PREFIX = "host:";

// ── Numbers ────────────────────────────────────────────────────────────────

const SCALE: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mm: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
};

const NUMBER_RE =
  /(-?\d+(?:\.\d+)?)\s*(k|m|b|thousand|million|billion|bn|mm)?(?![a-z])/gi;

/** A single scalar: optional sign and currency, digits with optional
 * thousands separators and decimals, an optional scale word, optional %. */
const SCALAR_RE =
  /^[+-]?[$€£]?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:k|m|b|thousand|million|billion|bn|mm)?\s*%?$/i;

/** Every number in a text, thousands separators removed and k/m/b scaled. */
export const numbersIn = (text: string): number[] =>
  [...text.replace(/(\d),(?=\d{3}\b)/g, "$1").matchAll(NUMBER_RE)].flatMap(
    ([, digits, scale]) =>
      digits === undefined
        ? []
        : [parseFloat(digits) * (SCALE[(scale ?? "").toLowerCase()] ?? 1)],
  );

/** The value of a numeric expected answer, or null when it is not exactly
 * one finite number (a sentence, a date, or several figures). */
export const parseNumericExpected = (expected: string): number | null => {
  const scalar = expected.trim();
  if (!SCALAR_RE.test(scalar)) return null;
  const values = numbersIn(scalar.replace(/[$€£\s]/g, ""));
  const [value] = values;
  return values.length === 1 && value !== undefined && Number.isFinite(value)
    ? value
    : null;
};

// ── Apps ───────────────────────────────────────────────────────────────────

/** RFC 1123 labels, case-insensitive, at most 253 characters: a concrete
 * host, so a malformed requirement can never match by normalization. No
 * wildcard, port, path or userinfo. */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
export const isConcreteHost = (host: string): boolean =>
  host.length > 0 &&
  host.length <= 253 &&
  host.split(".").every((label) => HOST_LABEL.test(label));

/** The gateway logs CONNECT hosts with their optional `:443`. Strip only
 * that exact port, never parse a URL. */
export const normalizeLoggedHost = (host: string): string =>
  host.toLowerCase().replace(/:443$/, "");

/** Lowercased, trimmed, de-duplicated app IDs, in first-seen order. */
const normalizeEvalApps = (apps: readonly string[]): string[] => [
  ...new Set(apps.map((app) => app.trim().toLowerCase()).filter(Boolean)),
];

// ── The question body ──────────────────────────────────────────────────────

export const NUMERIC_EXPECTED_MESSAGE =
  "Enter one number, such as 3200000 or $3.2M, not a sentence or date.";

export const evalQuestionSchema = z
  .object({
    question: z
      .string()
      .trim()
      .min(1, "Enter a question for your agent.")
      .max(
        EVAL_TEXT_MAX_LENGTH,
        "Keep the question to 4,000 characters or fewer.",
      ),
    expected: z
      .string()
      .trim()
      .min(1, "Enter the expected answer.")
      .max(
        EVAL_TEXT_MAX_LENGTH,
        "Keep the expected answer to 4,000 characters or fewer.",
      ),
    kind: z.enum(EVAL_CHECK_KINDS),
    expectedApps: z
      .array(
        z
          .string()
          .max(
            EVAL_APP_ID_MAX_LENGTH,
            "Each app ID must be 100 characters or fewer.",
          ),
      )
      .max(EVAL_APPS_MAX, "Use no more than 20 apps.")
      .default([])
      .transform(normalizeEvalApps),
  })
  .refine(
    (input) =>
      input.kind !== "numeric" || parseNumericExpected(input.expected) !== null,
    { path: ["expected"], message: NUMERIC_EXPECTED_MESSAGE },
  );
export type EvalQuestionInput = z.input<typeof evalQuestionSchema>;
export type EvalQuestionBody = z.output<typeof evalQuestionSchema>;
