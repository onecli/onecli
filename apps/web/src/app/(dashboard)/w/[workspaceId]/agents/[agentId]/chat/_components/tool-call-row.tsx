"use client";

import { ChevronRight } from "lucide-react";
import {
  activityForToolCall,
  bareToolName,
} from "@onecli/agent-protocol/activity";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@onecli/ui/components/collapsible";
import { toolInputPreview } from "@/lib/chat/tool-display";
import type { ToolCall } from "@/lib/chat/transcript";
import { cn } from "@onecli/ui/lib/utils";
import { ToolInput } from "./tool-input";
import { ToolOutput } from "./tool-output";

/** One timeline row: the same height as a note, so the dots line up. */
const ROW =
  "flex min-w-0 items-center gap-1.5 py-1 text-[0.8125rem] leading-[1.125rem]";

/**
 * One step in the work timeline, modeled on Claude's run view:
 *
 *   • Ran a command  ls -la /data >          (done; click for request + output)
 *   • Ran a command  grep x  exit 1 >        (the command exited non-zero)
 *   • Ran a command  Failed >                (the tool failed: red dot, "Failed")
 *   ● Running a command                      (still going: the dot pulses)
 *
 * No status icons: the timeline's dot carries the state (WorkTimeline reads
 * `toolStepState`), the words carry the rest, and red is reserved for the
 * one thing worth noticing, a step whose TOOL failed. A
 * command that ran and exited non-zero is not that: `grep` exits 1 when it
 * finds nothing, which is often the answer. Its status shows as a muted
 * `exit N`. The label comes from the shared phrase table, never the raw tool
 * name (sandbox-controlled text); the preview is the call's primary argument,
 * when the harness reported one (it arrives with the call's result, so a live
 * chat row gets it as the step finishes). Expanding shows the tool's name,
 * its request (ToolInput) and its output (ToolOutput).
 *
 * SECURITY: `tool.name`, `tool.input` and `tool.output` are untrusted
 * sandbox text. All render as text, never as markup or markdown.
 */

/** Where a step stands: still going, its tool failed, or done. A finished
 *  turn can't still be running a tool, so an orphan reads as done. */
export const toolStepState = (
  tool: ToolCall,
  turnEnded: boolean,
): "running" | "failed" | "done" =>
  tool.output === undefined && !turnEnded
    ? "running"
    : tool.isError === true
      ? "failed"
      : "done";

export const ToolCallRow = ({
  tool,
  turnEnded,
}: {
  tool: ToolCall;
  /** A finished turn can't still be running a tool: render the orphan done. */
  turnEnded: boolean;
}) => {
  const state = toolStepState(tool, turnEnded);
  const running = state === "running";
  const failed = state === "failed";
  const preview = toolInputPreview(tool.input);

  const label = (
    <>
      <span className="shrink-0">
        {activityForToolCall(tool.name, tool.input, running, tool)}
      </span>
      {preview && (
        <code
          translate="no"
          className="text-foreground/80 min-w-0 truncate font-mono text-xs"
        >
          {preview}
        </code>
      )}
      {running && <span className="sr-only">running</span>}
      {tool.exitCode !== undefined && (
        <span
          translate="no"
          className="text-muted-foreground shrink-0 font-mono text-[11px] leading-none"
        >
          exit {tool.exitCode}
        </span>
      )}
      {failed && (
        <span className="shrink-0 text-[11px] leading-none text-red-700 dark:text-red-400">
          Failed
        </span>
      )}
    </>
  );

  if (!tool.input && !tool.output) {
    return <div className={cn(ROW, "text-muted-foreground")}>{label}</div>;
  }

  return (
    <Collapsible>
      <CollapsibleTrigger
        className={cn(
          ROW,
          "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 group w-full rounded-md text-start transition-colors outline-none focus-visible:ring-[3px]",
        )}
      >
        {label}
        <ChevronRight
          className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1 pb-2">
        <p
          translate="no"
          className="text-muted-foreground mb-1 truncate font-mono text-xs"
        >
          {bareToolName(tool.name) || "tool"}
        </p>
        {tool.input && <ToolInput text={tool.input} />}
        {tool.output && <ToolOutput text={tool.output} failed={failed} />}
      </CollapsibleContent>
    </Collapsible>
  );
};
