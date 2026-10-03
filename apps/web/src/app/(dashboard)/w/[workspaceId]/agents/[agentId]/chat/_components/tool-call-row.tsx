"use client";

import { ChevronRight, Loader2 } from "lucide-react";
import {
  activityForTool,
  bareToolName,
  finishedActivityForTool,
} from "@onecli/agent-protocol/activity";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@onecli/ui/components/collapsible";
import type { ToolCall } from "@/lib/chat/transcript";
import { stepFailed, ToolOutput } from "./tool-output";

/**
 * One step inside a tool group's card, modeled on Claude's run view:
 *
 *   Ran a command >             (done; click to see the output)
 *   Ran a command  Failed >     (the step failed, "Failed" in red)
 *   ⟳ Running a command         (still going)
 *
 * No status icons on finished rows: the words carry the state, and red is
 * reserved for the one thing worth noticing, a failed step. Expanding shows
 * the tool's name and its output (ToolOutput). The label comes from the
 * shared phrase table, never the raw tool name (sandbox-controlled text).
 *
 * SECURITY: `tool.name` and `tool.output` are untrusted sandbox text. Both
 * render as text, never as markup or markdown.
 */
export const ToolCallRow = ({
  tool,
  turnEnded,
}: {
  tool: ToolCall;
  /** A finished turn can't still be running a tool — render the orphan done. */
  turnEnded: boolean;
}) => {
  const running = tool.output === undefined && !turnEnded;
  const failed = !running && stepFailed(tool);

  const label = (
    <>
      {running && (
        <Loader2
          className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden
        />
      )}
      <span className="min-w-0 truncate">
        {running
          ? activityForTool(tool.name)
          : finishedActivityForTool(tool.name)}
      </span>
      {running && <span className="sr-only">running</span>}
      {failed && (
        <span className="shrink-0 text-[11px] leading-none text-red-700 dark:text-red-400">
          Failed
        </span>
      )}
    </>
  );

  if (!tool.output) {
    return (
      <div className="text-muted-foreground flex items-center gap-1.5 px-3 py-2 text-sm">
        {label}
      </div>
    );
  }

  return (
    <Collapsible>
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 group flex w-full items-center gap-1.5 px-3 py-2 text-start text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-inset">
        {label}
        <ChevronRight
          className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-3">
        <p
          translate="no"
          className="text-muted-foreground mb-1 truncate font-mono text-xs"
        >
          {bareToolName(tool.name) || "tool"}
        </p>
        <ToolOutput text={tool.output} failed={failed} />
      </CollapsibleContent>
    </Collapsible>
  );
};
