import {
  countEvalOutcomes,
  type EvalReportWhen,
  type EvalResultView,
} from "../validations/evals";
import type { MessageSection } from "./channels/types";

/**
 * The message a scheduled eval run sends when it finishes, written by the
 * platform (never a model) so the same run always reads the same way.
 * Markdown: the web chat renders it, and the channel provider turns it
 * into its own format (Slack mrkdwn).
 *
 * Written for a person skimming a channel, not a log:
 *
 *   **Dana's scheduled tests: 1 of 3 passed** (1 broke since last run)
 *
 *   **Needs a look**
 *   **2. Summarize last week's support tickets.**
 *   > Broke since last run. The answer had no ticket data, only a question
 *   > back about which support system to use.
 *
 *   **Passing**
 *   1. Explain what OneCLI is
 *
 *   _claude-sonnet-5 · took 1m 20s · no changes to the agent since last run_
 *   [Open the full results](…)
 */

/** Questions listed before "and N more". */
const MAX_LISTED = 15;
/** A question as it appears on its line. */
const MAX_QUESTION_CHARS = 100;
/** The reason under a question. */
const MAX_REASON_CHARS = 200;

interface EvalReportInput {
  agentName: string;
  status: "done" | "failed";
  error: string | null;
  total: number;
  results: EvalResultView[];
  runUrl: string;
  model?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  /** Whether the agent's setup (instructions, model, skills, rules) differs
   * from the run it is compared with; null when there is no earlier run. */
  configChanged?: boolean | null;
}

/** A question's label in a report: its position in the run (1-based), the
 * same order as the Evals page. The red/green side already says whether it
 * passed, so the number is all it needs. */
const numbered = (n: number, text: string) => `${n}. ${text}`;

/** One line, clipped. Model and author text can carry newlines and
 * markdown that would break the layout. */
const clip = (text: string, max: number) => {
  const line = text
    .replace(/[*_`[\]>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** A sentence: capitalized, ending in a period. */
const sentence = (text: string) => {
  const t = text.trim().replace(/[.…]+$/, "");
  return t ? `${t[0]?.toUpperCase()}${t.slice(1)}.` : "";
};

const duration = (from?: Date | null, to?: Date | null) => {
  if (!from || !to) return null;
  const seconds = Math.max(
    0,
    Math.round((to.getTime() - from.getTime()) / 1000),
  );
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
};

/** Why a question did not pass, as a person would say it. */
const reasonOf = (r: EvalResultView): string => {
  const missing =
    r.missingApps && r.missingApps.length > 0
      ? ` It didn't use ${r.missingApps.join(", ")}.`
      : "";
  if (r.outcome === "error")
    return `It didn't finish: ${clip(r.error ?? "no reason given", MAX_REASON_CHARS)}`;
  if (r.outcome === "inconclusive")
    return r.judgeError
      ? `The answer couldn't be judged: ${clip(r.judgeError, MAX_REASON_CHARS)}`
      : "The answer couldn't be checked.";
  if (r.judgement?.summary)
    return clip(sentence(r.judgement.summary), MAX_REASON_CHARS) + missing;
  if (r.kind === "custom")
    return `The answer didn't meet the criteria.${missing}`;
  const said = r.answer ? `"${clip(r.answer, 80)}"` : "nothing";
  return `Expected ${clip(r.expected, 60)}, the agent said ${said}.${missing}`;
};

/** Criteria listed under a failing custom check before "and N more". */
const MAX_CRITERIA = 6;
/** The judge's note on one criterion. */
const MAX_NOTE_CHARS = 110;

/** A custom check's criteria, met first then missed, one per quoted line:
 *   > ✓ The total number of tickets: "26 cases"
 *   > ✗ The three most common issues: no issues are listed */
const criteriaLines = (r: EvalResultView): string[] => {
  const criteria = r.judgement?.criteria ?? [];
  if (criteria.length === 0) return [];
  const sorted = [...criteria].sort((a, b) => Number(b.met) - Number(a.met));
  const shown = sorted.slice(0, MAX_CRITERIA);
  const lines = shown.map((c) => {
    const note = clip(c.note, MAX_NOTE_CHARS).replace(/\.$/, "");
    return `${c.met ? "✅" : "❌"} ${clip(c.criterion, 90)}${note ? `: _${note}_` : ""}`;
  });
  const more = criteria.length - shown.length;
  return [
    `${criteria.filter((c) => c.met).length} of ${criteria.length} criteria met`,
    ...lines,
    ...(more > 0 ? [`…and ${more} more`] : []),
  ];
};

/** A question that needs attention: its title, then (unquoted) the reason
 * and criteria. Each surface indents the detail its own way. */
const failingBlock = (r: EvalResultView, n: number): string[] => {
  const tag =
    r.change === "regressed"
      ? "Broke since last run. "
      : r.change === "new"
        ? "New question. "
        : "";
  return [
    `**${numbered(n, clip(r.question, MAX_QUESTION_CHARS))}**`,
    `${tag}${reasonOf(r)}`,
    ...criteriaLines(r),
  ];
};

/** A passing question; a custom check also lists its criteria under it,
 * so the green side shows what the answer got right. */
const passingBlock = (r: EvalResultView, n: number): string[] => [
  `${numbered(n, clip(r.question, MAX_QUESTION_CHARS))}${r.change === "fixed" ? " (fixed since last run)" : ""}`,
  ...criteriaLines(r),
];

/** Whether this run is sent under the schedule's `when`. A run that failed
 * outright is always sent: nobody should learn of a broken schedule late. */
export const shouldSendEvalReport = (
  when: EvalReportWhen,
  input: Pick<EvalReportInput, "status" | "results">,
): boolean => {
  if (input.status === "failed" || when === "always") return true;
  if (when === "changes")
    return input.results.some(
      (r) => r.change === "regressed" || r.change === "fixed",
    );
  return input.results.some((r) => r.outcome !== "passed");
};

/** A report in parts, so each surface can lay it out its own way: the
 * chat as one markdown message, a channel with colored side bars. */
interface EvalReportParts {
  headline: string;
  /** The run's own failure, when it didn't finish. */
  runError: string | null;
  /** Each failing question's block (title, reason, criteria), unquoted. */
  failing: string[];
  /** Each passing question: its line, then any criteria, unquoted. */
  passing: string[];
  /** "…and N more." when the list was capped. */
  more: string | null;
  footer: string | null;
  link: string;
}

/** Quote every line (the chat's indent for reasons and criteria). */
const quoted = (block: string[]) => block.map((l) => `> ${l}`);

const evalReportParts = (input: EvalReportInput): EvalReportParts => {
  const counts = countEvalOutcomes(input.results, input.total);
  const broke = input.results.filter((r) => r.change === "regressed").length;
  const fixed = input.results.filter((r) => r.change === "fixed").length;
  const allPassed = counts.passed === input.total && input.total > 0;

  const changes = [
    broke > 0 && `${broke} broke since last run`,
    fixed > 0 && `${fixed} fixed`,
  ].filter(Boolean);

  const headline =
    input.status === "failed"
      ? `**${input.agentName}'s scheduled tests didn't finish** (${counts.passed} of ${input.total} passed before it stopped)`
      : allPassed
        ? `**${input.agentName}'s scheduled tests: all ${input.total} passed** 🎉${changes.length > 0 ? ` (${changes.join(", ")})` : ""}`
        : `**${input.agentName}'s scheduled tests: ${counts.passed} of ${input.total} passed**${changes.length > 0 ? ` (${changes.join(", ")})` : ""}`;

  // Each question keeps its place in the run, wherever it is listed.
  const numberOf = new Map(input.results.map((r, i) => [r, i + 1]));
  const failing = input.results
    .filter((r) => r.outcome !== "passed" && r.outcome !== "pending")
    .sort(
      (a, b) =>
        Number(b.change === "regressed") - Number(a.change === "regressed"),
    );
  const passing = input.results.filter((r) => r.outcome === "passed");

  // Failures first; the cap lands on passes before it lands on failures.
  const shownFailing = failing.slice(0, MAX_LISTED);
  const shownPassing = passing.slice(
    0,
    Math.max(0, MAX_LISTED - shownFailing.length),
  );
  const hidden =
    failing.length + passing.length - shownFailing.length - shownPassing.length;

  const took = duration(input.startedAt, input.finishedAt);
  const footer = [
    input.model,
    took && `took ${took}`,
    input.configChanged === true
      ? "the agent changed since last run"
      : input.configChanged === false
        ? "no changes to the agent since last run"
        : null,
  ].filter(Boolean);

  return {
    headline,
    runError:
      input.status === "failed"
        ? sentence(clip(input.error ?? "The run failed", MAX_REASON_CHARS))
        : null,
    failing: shownFailing.map((r) =>
      failingBlock(r, numberOf.get(r) ?? 0).join("\n"),
    ),
    passing: shownPassing.map((r) =>
      passingBlock(r, numberOf.get(r) ?? 0).join("\n"),
    ),
    more: hidden > 0 ? `…and ${hidden} more.` : null,
    footer: footer.length > 0 ? `_${footer.join(" · ")}_` : null,
    link: `[Open the full results](${input.runUrl})`,
  };
};

/** The chat's single markdown message. */
export const evalReportText = (input: EvalReportInput): string => {
  const p = evalReportParts(input);
  return [
    p.headline,
    "",
    ...(p.runError ? [`> ${p.runError}`, ""] : []),
    ...(p.failing.length > 0
      ? [
          "**Needs a look**",
          ...p.failing.flatMap((block) => {
            const [title = "", ...rest] = block.split("\n");
            return [title, ...quoted(rest), ""];
          }),
        ]
      : []),
    ...(p.passing.length > 0
      ? [
          "**Passing**",
          ...p.passing.flatMap((block, i) => {
            const [title = "", ...rest] = block.split("\n");
            const last = i === p.passing.length - 1;
            return rest.length > 0 && !last
              ? [title, ...quoted(rest), ""]
              : [title, ...quoted(rest)];
          }),
          "",
        ]
      : []),
    ...(p.more ? [p.more, ""] : []),
    ...(p.footer ? [p.footer] : []),
    p.link,
  ].join("\n");
};

/** A channel post: the headline as the message, then colored side bars
 * (red for what needs a look, green for what passed) and a plain footer. */
export const evalReportSections = (
  input: EvalReportInput,
): { text: string; sections: MessageSection[] } => {
  const p = evalReportParts(input);
  const indent = (block: string) => {
    const [title = "", ...rest] = block.split("\n");
    return [title, ...rest.map((l) => `      ${l}`)].join("\n");
  };
  const sections: MessageSection[] = [];
  if (p.failing.length > 0)
    sections.push({
      tone: "bad",
      text: ["**Needs a look**", ...p.failing.map(indent)].join("\n\n"),
    });
  if (p.passing.length > 0)
    sections.push({
      tone: "good",
      text: ["**Passing**", ...p.passing.map(indent)].join(
        p.passing.some((b) => b.includes("\n")) ? "\n\n" : "\n",
      ),
    });
  sections.push({
    tone: "neutral",
    text: [p.more, p.footer, p.link].filter(Boolean).join("\n"),
  });
  return {
    text: [p.headline, ...(p.runError ? [p.runError] : [])].join("\n"),
    sections,
  };
};
