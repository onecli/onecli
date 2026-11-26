"use client";

import { ChevronDown, Loader2 } from "lucide-react";
import {
  activityForToolCall,
  toolKind,
  type ToolKind,
} from "@onecli/agent-protocol/activity";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@onecli/ui/components/collapsible";
import { cn } from "@onecli/ui/lib/utils";
import type { ToolCall, WorkStep } from "@/lib/chat/transcript";
import { ElapsedSince, formatElapsed } from "./elapsed-since";
import { ToolCallRow, toolStepState } from "./tool-call-row";

/**
 * The agent's work in a turn, as ONE header row over a timeline of what it
 * did, modeled on Claude's and Tasklet's run views:
 *
 *   ⟳ Running 3 commands · 12s ⌄    (while it works; timer = whole turn)
 *   Worked for 14s ⌄                 (settled)
 *   Stopped after 9s ⌄               (failed or stopped)
 *   Ran 3 commands ⌄                 (history with no finish time)
 *
 * Opening it shows the steps in the order they happened, on a thin line
 * with a dot per step: each tool call (expandable to its request and
 * output), the agent's notes between them, and the titles of its thinking
 * (both live only: history carries neither). A running step's dot pulses;
 * a failed step's dot is red. No color on the header: the only color in
 * the view is a failed step.
 *
 * The same element from the first tool call to the record, so a step the
 * reader opened while the turn ran is still open when it settles.
 *
 * SECURITY: every string here is untrusted sandbox text (tool names,
 * inputs, outputs, notes, thought titles). All render as TEXT, never markup
 * or markdown; tool labels come from the shared phrase table, never the raw
 * tool name.
 */

/** How a run of one kind of tool is counted, in both tenses. Keyed on every
 *  ToolKind, so a kind added to the phrase table cannot go uncounted here. */
const COUNTED: Record<
  ToolKind | "step",
  { running: string; done: string; many: string }
> = {
  command: { running: "Running", done: "Ran", many: "commands" },
  read: { running: "Reading", done: "Read", many: "files" },
  edit: { running: "Editing", done: "Edited", many: "files" },
  fetch: { running: "Fetching", done: "Fetched", many: "pages" },
  search: { running: "Running", done: "Ran", many: "searches" },
  step: { running: "Running", done: "Ran", many: "steps" },
};

/** "Messaged another agent", "Running 3 commands", "Read 2 files", "Ran 2
 *  steps": a single step says what it did (the same words as its row), a
 *  run of one kind is counted by what it works on, a mixed run by steps. */
export const groupLabel = (tools: ToolCall[], running: boolean): string => {
  const [first] = tools;
  if (tools.length === 1 && first)
    return activityForToolCall(first.name, first.input, running, first);
  const kinds = new Set(tools.map((tool) => toolKind(tool.name)));
  const [only] = kinds;
  const counted = COUNTED[kinds.size === 1 && only ? only : "step"];
  return `${running ? counted.running : counted.done} ${tools.length} ${counted.many}`;
};

/**
 * The settled header: how long the turn worked, from its start to its
 * finish. Null when that is unknown (a row with no finish time, a clock
 * that makes no sense), so the caller falls back to counting the steps.
 */
export const settledLabel = ({
  startedAt,
  finishedAt,
  stopped,
}: {
  startedAt: string;
  finishedAt?: string | null;
  stopped: boolean;
}): string | null => {
  if (!finishedAt) return null;
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  // Under a second still worked: "0s" would read as nothing happened.
  const took = formatElapsed(Math.max(ms, 1_000));
  return stopped ? `Stopped after ${took}` : `Worked for ${took}`;
};

/** A note in the timeline is a log line: emphasis and code markers the
 *  model wrote are dropped, whitespace collapsed. Display only; the text
 *  still renders as text. */
const plainNote = (text: string): string =>
  text
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The step's dot on the line, centered on its first text line (13px into
 *  an 18px-tall row with 4px of padding). */
const Dot = ({ state }: { state: "running" | "failed" | "done" | "aside" }) => (
  <span
    aria-hidden
    data-state={state}
    className={cn(
      "absolute start-0 top-[0.8125rem] size-[7px] -translate-y-1/2 rounded-full",
      state === "running" && "bg-foreground/70 motion-safe:animate-pulse",
      state === "failed" && "bg-red-600 dark:bg-red-400",
      state === "done" && "bg-muted-foreground/45",
      // Notes and thoughts: the agent talking, not acting. Hollow.
      state === "aside" && "border-muted-foreground/45 bg-background border",
    )}
  />
);

export const WorkTimeline = ({
  tools,
  steps,
  turnEnded,
  startedAt,
  finishedAt,
  stopped = false,
  defaultOpen = false,
}: {
  tools: ToolCall[];
  /** The work in the order it happened (the fold's `steps`). Without it,
   *  the tool calls alone, in order. */
  steps?: WorkStep[];
  turnEnded: boolean;
  /** When the turn started (ISO). The timer counts from here to the answer,
   *  not from the current step, so it never resets between steps. */
  startedAt: string;
  /** When the turn finished (ISO): the settled header's duration. */
  finishedAt?: string | null;
  /** The turn failed or was stopped: "Stopped after", not "Worked for". */
  stopped?: boolean;
  /** Open on mount: where the steps are the point (a run's detail), not
   *  the answer. */
  defaultOpen?: boolean;
}) => {
  // The header stays live for the whole turn, between steps too, so the
  // spinner and timer run until the answer arrives.
  const running = !turnEnded;
  const label = running
    ? groupLabel(tools, true)
    : (settledLabel({ startedAt, finishedAt, stopped }) ??
      groupLabel(tools, false));
  const timeline: WorkStep[] =
    steps && steps.length > 0
      ? steps
      : tools.map((_, index) => ({ kind: "tool", index }));

  return (
    <Collapsible defaultOpen={defaultOpen}>
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 group flex items-center gap-1.5 rounded-md py-1 text-start text-sm transition-colors outline-none focus-visible:ring-[3px]">
        {running && (
          <Loader2
            className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
        )}
        <span>{label}</span>
        {running && (
          <span className="text-muted-foreground/60">
            <span aria-hidden>· </span>
            <ElapsedSince since={startedAt} />
          </span>
        )}
        <ChevronDown
          className="size-3.5 shrink-0 transition-transform group-data-[state=closed]:-rotate-90"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="ms-1 mt-1">
          {timeline.map((step, position) => {
            const tool = step.kind === "tool" ? tools[step.index] : undefined;
            if (step.kind === "tool" && !tool) return null;
            return (
              <li
                key={
                  tool
                    ? // callId can be empty on an orphaned finish; fall
                      // back to the position so keys stay unique.
                      tool.callId || `tool-${position}`
                    : `${step.kind}-${position}`
                }
                data-step={step.kind}
                className={cn(
                  "relative ps-5",
                  // The thread from this dot down to the next one (into
                  // the next row, which starts above its dot). The last
                  // step has nothing below it.
                  "before:bg-border before:absolute before:start-[3px] before:top-[1.125rem] before:-bottom-2 before:w-px last:before:hidden",
                )}
              >
                <Dot state={tool ? toolStepState(tool, turnEnded) : "aside"} />
                {tool ? (
                  <ToolCallRow tool={tool} turnEnded={turnEnded} />
                ) : step.kind !== "tool" ? (
                  <p
                    className={cn(
                      "py-1 text-[0.8125rem] leading-[1.125rem] break-words",
                      step.kind === "note"
                        ? "text-foreground/75"
                        : "text-muted-foreground",
                    )}
                  >
                    {step.kind === "note" ? plainNote(step.text) : step.text}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
};
