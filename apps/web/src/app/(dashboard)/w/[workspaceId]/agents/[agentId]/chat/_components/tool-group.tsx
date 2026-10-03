"use client";

import { ChevronDown, Loader2 } from "lucide-react";
import {
  activityForTool,
  finishedActivityForTool,
  toolKind,
  type ToolKind,
} from "@onecli/agent-protocol/activity";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@onecli/ui/components/collapsible";
import type { ToolCall } from "@/lib/chat/transcript";
import { ElapsedSince } from "./elapsed-since";
import { ToolCallRow } from "./tool-call-row";

/**
 * The agent's work in a turn, shown as ONE header row instead of a growing
 * stack of tool lines, modeled on Claude's run view:
 *
 *   ⟳ Running 3 commands · 12s ⌄     (until the answer; timer = whole turn)
 *   Ran 17 commands ⌄                (settled)
 *
 * Opening it shows a bordered card with one row per step (ToolCallRow).
 * No color on the header: the only color in the view is a failed step's red
 * inside the card.
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
    return running
      ? activityForTool(first.name)
      : finishedActivityForTool(first.name);
  const kinds = new Set(tools.map((tool) => toolKind(tool.name)));
  const [only] = kinds;
  const counted = COUNTED[kinds.size === 1 && only ? only : "step"];
  return `${running ? counted.running : counted.done} ${tools.length} ${counted.many}`;
};

export const ToolGroup = ({
  tools,
  turnEnded,
  startedAt,
}: {
  tools: ToolCall[];
  turnEnded: boolean;
  /** When the turn started (ISO). The timer counts from here to the answer,
   *  not from the current step, so it never resets between steps. */
  startedAt: string;
}) => {
  // The header stays live for the whole turn, between steps too, so the
  // spinner and timer run until the answer arrives.
  const running = !turnEnded;

  return (
    <Collapsible>
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 group flex items-center gap-1.5 rounded-md py-1 text-start text-sm transition-colors outline-none focus-visible:ring-[3px]">
        {running && (
          <Loader2
            className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
        )}
        <span>{groupLabel(tools, running)}</span>
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
        <div className="mt-1 divide-y overflow-hidden rounded-xl border">
          {tools.map((tool, index) => (
            <ToolCallRow
              // callId can be empty on an orphaned finish; fall back to the
              // position so keys stay unique.
              key={tool.callId || `tool-${index}`}
              tool={tool}
              turnEnded={turnEnded}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
