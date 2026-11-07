import { logger } from "../../lib/logger";
import {
  answersTyped,
  classify,
  type Answers,
  type ClassifyInput,
  type Question,
} from "./classify";
import type { LlmCallKey } from "../llm-direct-call";

/**
 * AN LLM JUDGE: one small, fast decision about a person's message, made on
 * the agent's own fast-model key before the platform acts on it ("who is
 * this for?", "does this change the held request?", "which emoji?").
 *
 * `defineJudge` is the one place the cross-cutting rules live, so a new
 * judge is only what it asks and what the answers mean:
 *
 * - a DEADLINE: the judge always resolves by `deadlineMs`, even when a model
 *   call or a slow read is stuck; every model call is cancelled with it;
 * - a FALLBACK: a refusal, timeout, unreadable answer or thrown error yields
 *   `fallback` - the judge's documented safe default - never an exception;
 * - ONE LOG LINE per verdict (judge, verdict, path, ms, outcome) plus the
 *   ids the judge names. Never message content: what people say is
 *   customer data and stays out of logs.
 *
 * Judges see the model only through `ask`, which injects the key and the
 * deadline and records which path answered.
 */

export type Ask = (<const Q extends readonly Question[]>(
  request: Omit<ClassifyInput<Q>, "key" | "signal">,
) => Promise<Answers<Q>>) & {
  /** This key answers several typed questions in one call (OpenAI
   * Decisions): a judge may batch every question into one ask. */
  readonly typed: boolean;
};

export interface JudgeSpec<I, V> {
  /** Log name: `reply`, `supersede`, `reaction`. */
  name: string;
  /** The whole judge's budget, from call to verdict. */
  deadlineMs: number;
  /** The safe answer whenever there is no real one. */
  fallback: V;
  /** Ask the questions (via `ask`, any number of times) and decide. */
  decide: (input: I, ask: Ask) => Promise<V>;
  /** The verdict as a short log value (no content). Default: JSON. */
  describe?: (verdict: V) => string;
  /** Ids to stamp on the log line (agent, conversation). Never text. */
  logFields?: (input: I) => Record<string, string | number | undefined>;
  /** A cosmetic judge logs at debug, not info. */
  quiet?: boolean;
}

export interface JudgeCall {
  /** The agent's fast-model key, resolved by the caller. */
  key: LlmCallKey;
  /** The caller's own cancellation, combined with the judge's deadline. */
  signal?: AbortSignal;
}

export type Judge<I, V> = (input: I & JudgeCall) => Promise<V>;

type Outcome = "answered" | "fallback" | "deadline";

const log = logger.child({ component: "llm-judge" });

export const defineJudge = <I, V>(spec: JudgeSpec<I, V>): Judge<I, V> => {
  const describe = spec.describe ?? ((v: V) => JSON.stringify(v));
  return async (input) => {
    const started = Date.now();
    // One controller IS the deadline: the timer that resolves the judge also
    // aborts every model call still in flight, so nothing outlives the
    // verdict (an AbortSignal.timeout here would fire on a separate clock).
    const deadline = new AbortController();
    const signal = AbortSignal.any([
      deadline.signal,
      ...(input.signal ? [input.signal] : []),
    ]);
    const paths = new Set<string>();
    const ask: Ask = Object.assign(
      async <const Q extends readonly Question[]>(
        request: Omit<ClassifyInput<Q>, "key" | "signal">,
      ): Promise<Answers<Q>> => {
        const { answers, via } = await classify({
          ...request,
          key: input.key,
          signal,
        });
        paths.add(via);
        return answers;
      },
      { typed: answersTyped(input.key) },
    );

    let outcome: Outcome = "answered";
    let error: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<V>((resolve) => {
      timer = setTimeout(() => {
        outcome = "deadline";
        deadline.abort(new Error(`${spec.name} judge: deadline`));
        resolve(spec.fallback);
      }, spec.deadlineMs);
    });
    const verdict = await Promise.race([
      spec.decide(input, ask).catch((err: unknown) => {
        outcome = signal.aborted ? "deadline" : "fallback";
        error = String(err);
        return spec.fallback;
      }),
      expired,
    ]).finally(() => clearTimeout(timer));

    const fields = {
      judge: spec.name,
      verdict: describe(verdict),
      outcome,
      via: [...paths].join("+") || undefined,
      ms: Date.now() - started,
      ...(error && { err: error }),
      ...spec.logFields?.(input),
    };
    if (spec.quiet) log.debug(fields, "judge verdict");
    else log.info(fields, "judge verdict");
    return verdict;
  };
};
