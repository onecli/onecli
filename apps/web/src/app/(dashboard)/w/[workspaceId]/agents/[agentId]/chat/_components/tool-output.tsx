"use client";

import { memo } from "react";
import { cn } from "@onecli/ui/lib/utils";

/**
 * A step's output, with MINIMAL coloring so the lines that matter stand out:
 * error lines and a non-zero exit code in red, a zero exit code in green,
 * everything else in the normal foreground color. A failed step also gets
 * the whole panel tinted red (like Claude's failed "Output" block), so the
 * reader sees which step went wrong without reading every line.
 *
 * The coloring keys on the SHAPES tools write, never on words anywhere in a
 * line: output is often a file or a search result, and a README that
 * mentions "error" is not an error.
 *
 * SECURITY: the output is UNTRUSTED sandbox text. Each line renders as a
 * TEXT node inside a <span>; coloring is decided by pattern tests on the
 * text, never by interpreting it (no HTML, no markdown, no ANSI
 * passthrough). ANSI escape sequences and carriage returns are stripped.
 */

// ESC [ ... final-byte: the SGR/CSI sequences a CLI prints for its own colors.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * The exit-code trailer the agent runtime appends to a shell command's
 * output, as a whole line: `Exit code: 2` (a foreground command that exited
 * non-zero) or `--- Command finished with exit code: 0 ---` (a background
 * one, any code).
 */
const EXIT_TRAILER =
  /^(?:---\s*)?(?:command finished with )?exit code:?\s*(-?\d+)(?:\s*---)?$/i;

/**
 * A line that reports an error, in the shapes tools actually print:
 *
 *  - the shell's own diagnostics (`bash: …`, `sh: …`);
 *  - a JSON body whose first key is "error" (an API's error response);
 *  - "An error occurred …" (the AWS CLI's failure line);
 *  - a remote command's exit (`command terminated with exit code 1`, from
 *    `kubectl exec`) or a test summary with a non-zero count (`Tests  3
 *    failed | 6 passed`), never a `0 failed` one;
 *  - a line that OPENS with an error word, after an optional decoration run
 *    (vitest's `⎯⎯ Failed Tests`, `✗ error`) and any run of `[tag]`, `>`,
 *    `line N:` or `name:` prefixes ("ls: cannot open", "src/a.ts:3:5: error
 *    TS2304", "TypeError: x", "ERR_PNPM_…"). An assignment (`panic =
 *    "abort"` in a config file) is not an error.
 *
 * Linear on untrusted output: each prefix ends at its own delimiter and
 * cannot start with another prefix's opener, so a line splits into prefixes
 * exactly one way (no catastrophic backtracking). The decoration run is a
 * possessive-style lookahead + backreference: once consumed it is never
 * re-split, or a long `⎯⎯⎯…x` line would be retried at every length.
 */
const DECORATION = String.raw`(?:(?=([⎯─━✗✖×❌]+))\1\s*)?`;
const PREFIXES = String.raw`(?:\[[^\]]*\]\s*|>\s*|line \d+:\s*|[^\s:\[>][^\s:]*:\s*)*`;
const ERROR_WORD = String.raw`(?:\w*(?:errors?|exception)|err_\w+|syntax error|fatal|panic|traceback|failed|failure|denied|forbidden|unauthori[sz]ed|cannot|can't|not found|command not found|no such file|permission denied)\b(?!\s*=)`;
const NONZERO_EXIT = String.raw`command terminated with exit code [1-9]`;
const FAILED_SUMMARY = String.raw`(?:test files|tests)\s+[1-9]\d* failed\b`;
const ERROR_LINE = new RegExp(
  String.raw`^(?:(?:ba|z|da)?sh: |\{\s*"error"\s*:|an error occurred\b|${NONZERO_EXIT}|${FAILED_SUMMARY}|${DECORATION}${PREFIXES}${ERROR_WORD})`,
  "i",
);

const exitCodeOfLine = (line: string): number | null => {
  const match = EXIT_TRAILER.exec(line.trim());
  return match ? Number(match[1]) : null;
};

const cleanLines = (text: string): string[] =>
  text.replace(ANSI, "").replace(/\r/g, "").split("\n");

/** The exit code a command's output ENDS with, or null when it reports
 *  none. Only the last non-blank line counts: an "exit code: 1" quoted
 *  in the middle of a file the agent read is not this command's. Reads the
 *  tail only, so it stays cheap on outputs re-checked every render. */
export const exitCodeOf = (text: string | undefined): number | null => {
  const trimmed = (text ?? "").trimEnd();
  const last = trimmed.slice(trimmed.lastIndexOf("\n") + 1);
  return exitCodeOfLine(last.replace(ANSI, ""));
};

/** A step failed when the tool reported an error, or its command exited
 *  non-zero (the runtime still counts that as a step that ran). */
export const stepFailed = (tool: {
  isError?: boolean;
  output?: string;
}): boolean => {
  if (tool.isError) return true;
  const code = exitCodeOf(tool.output);
  return code !== null && code !== 0;
};

type LineTone = "error" | "ok" | "plain";

export const toneOf = (line: string): LineTone => {
  const code = exitCodeOfLine(line);
  if (code !== null) return code === 0 ? "ok" : "error";
  return ERROR_LINE.test(line.trimStart()) ? "error" : "plain";
};

const TONE_CLASS: Record<LineTone, string | undefined> = {
  error: "text-red-700 dark:text-red-400",
  ok: "text-green-700 dark:text-green-400",
  plain: undefined,
};

/** Memoized on the props, like ChatMarkdown: the thread re-renders on every
 *  stream read, and an open panel would otherwise re-split and re-test up to
 *  30 KB of output each time though it never changes once rendered. */
export const ToolOutput = memo(
  ({
    text,
    failed = false,
  }: {
    text: string;
    /** The step failed: tint the whole panel red. */
    failed?: boolean;
  }) => {
    const lines = cleanLines(text);
    return (
      <div
        className={cn(
          "rounded-md p-2.5",
          failed ? "bg-red-50 dark:bg-red-950/40" : "bg-muted",
        )}
      >
        <p className="text-muted-foreground mb-1.5 text-xs font-medium">
          Output
        </p>
        <pre
          translate="no"
          className="text-foreground max-h-64 overflow-auto font-mono text-xs whitespace-pre-wrap"
        >
          {lines.map((line, index) => (
            // Positional keys are safe: the output is immutable once rendered.
            <span key={index} className={TONE_CLASS[toneOf(line)]}>
              {line}
              {index < lines.length - 1 ? "\n" : null}
            </span>
          ))}
        </pre>
      </div>
    );
  },
);
ToolOutput.displayName = "ToolOutput";
