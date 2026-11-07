import { afterAll, describe, expect, it } from "vitest";
import type { LlmCallKey } from "../services/llm-direct-call";

/**
 * THE SHARED LIVE-EVAL HARNESS for LLM judges: a labeled corpus run through
 * a judge's REAL code against the REAL models, once per provider key the
 * environment carries, so a wording change is measured instead of hoped.
 *
 * Opt-in and never in CI (real tokens, live models). One set of env vars
 * serves every judge; pick the judge with the file:
 *
 *   JUDGE_EVAL=1 \
 *   JUDGE_EVAL_ANTHROPIC_KEY=sk-ant-...  # optional: the Haiku path
 *   JUDGE_EVAL_ANTHROPIC_AUTH=oauth      # optional: a Claude subscription token
 *   JUDGE_EVAL_OPENAI_KEY=sk-...         # optional: the Decisions path
 *   JUDGE_EVAL_RUNS=3                    # optional: repeats per case
 *   pnpm --filter @onecli/api exec vitest run src/services/judges/<name>-judge.eval.test.ts
 *
 * Each provider prints accuracy, p50/p90 latency and every miss, then holds
 * a floor so a regression goes red. Add a case whenever a judge is wrong in
 * the wild (names replaced), with its right answer.
 */

export interface EvalCase<I, E> {
  label: string;
  input: I;
  expect: E;
}

export interface EvalSpec<I, V, E> {
  /** The judge's name, for the report. */
  name: string;
  cases: readonly EvalCase<I, E>[];
  /** Run the judge once for a case. */
  run: (key: LlmCallKey, input: I) => Promise<V>;
  /** The verdict as the comparable label (`reply thread`, `keep`). */
  label: (verdict: V) => E;
  /** The share of runs that must be right, per provider. */
  floor: number;
}

const ENABLED = Boolean(process.env.JUDGE_EVAL);
const RUNS = Number(process.env.JUDGE_EVAL_RUNS ?? 3);
const OPENAI_KEY = process.env.JUDGE_EVAL_OPENAI_KEY ?? "";
const ANTHROPIC_KEY = process.env.JUDGE_EVAL_ANTHROPIC_KEY ?? "";
const ANTHROPIC_AUTH =
  process.env.JUDGE_EVAL_ANTHROPIC_AUTH === "oauth" ? "oauth" : "api-key";

const PROVIDERS: { key: LlmCallKey; title: string }[] = [
  ...(ANTHROPIC_KEY
    ? [
        {
          key: {
            provider: "anthropic",
            authMode: ANTHROPIC_AUTH,
            value: ANTHROPIC_KEY,
          } as const,
          title: `anthropic (${ANTHROPIC_AUTH})`,
        },
      ]
    : []),
  ...(OPENAI_KEY
    ? [
        {
          key: { provider: "openai", value: OPENAI_KEY } as const,
          title: "openai",
        },
      ]
    : []),
];

interface Row {
  title: string;
  correct: number;
  total: number;
  p50: number;
  p90: number;
  misses: string[];
}

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;

/** Register a judge's eval: one test per provider key present. */
export const describeJudgeEval = <I, V, E>(spec: EvalSpec<I, V, E>): void => {
  const rows: Row[] = [];

  afterAll(() => {
    if (rows.length === 0) return;
    const pct = (r: Row) => Math.round((r.correct / r.total) * 100);
    console.log(
      [
        "",
        `${spec.name} judge eval: ${String(spec.cases.length)} cases x ${String(RUNS)} runs`,
        ...rows.map(
          (r) =>
            `${r.title.padEnd(20)} ${`${String(r.correct)}/${String(r.total)} (${String(pct(r))}%)`.padEnd(14)} p50 ${String(r.p50)}ms  p90 ${String(r.p90)}ms`,
        ),
        ...rows.flatMap((r) =>
          r.misses.length === 0
            ? []
            : ["", `${r.title} misses:`, ...r.misses.map((m) => `  - ${m}`)],
        ),
        "",
      ].join("\n"),
    );
  });

  describe.skipIf(!ENABLED || PROVIDERS.length === 0)(
    `${spec.name} judge eval (live models)`,
    () => {
      for (const provider of PROVIDERS) {
        it(
          provider.title,
          async () => {
            const ms: number[] = [];
            const misses: string[] = [];
            let correct = 0;
            for (const c of spec.cases) {
              for (let r = 0; r < RUNS; r += 1) {
                const started = Date.now();
                const got = spec.label(await spec.run(provider.key, c.input));
                ms.push(Date.now() - started);
                if (got === c.expect) correct += 1;
                else
                  misses.push(
                    `${c.label}: got ${String(got)}, want ${String(c.expect)}`,
                  );
              }
            }
            ms.sort((a, b) => a - b);
            const row: Row = {
              title: provider.title,
              correct,
              total: spec.cases.length * RUNS,
              p50: percentile(ms, 0.5),
              p90: percentile(ms, 0.9),
              misses,
            };
            rows.push(row);
            expect(row.correct / row.total).toBeGreaterThanOrEqual(spec.floor);
          },
          600_000,
        );
      }
    },
  );
};
