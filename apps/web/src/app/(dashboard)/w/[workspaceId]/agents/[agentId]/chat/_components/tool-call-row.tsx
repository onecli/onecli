"use client";

import { ChevronRight, CircleAlert, CircleCheck, Loader2 } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@onecli/ui/components/collapsible";
import { cn } from "@onecli/ui/lib/utils";
import type { ToolCall } from "@/lib/chat/transcript";

/**
 * One tool call in the thread: name, live state, and the output behind a
 * disclosure. The output is untrusted model-side text — it renders inside a
 * `<pre>` as text, never as markup or markdown.
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
  const Icon = running ? Loader2 : tool.isError ? CircleAlert : CircleCheck;

  const summary = (
    <>
      <Icon
        className={cn(
          "size-3.5 shrink-0",
          running && "animate-spin",
          tool.isError ? "text-destructive" : "text-muted-foreground",
        )}
        aria-hidden
      />
      <code className="min-w-0 truncate font-mono text-xs">
        {tool.name || "tool"}
      </code>
    </>
  );

  if (tool.output === undefined || tool.output === "") {
    return (
      <div className="text-muted-foreground flex items-center gap-1.5 py-0.5">
        {summary}
        {running && <span className="sr-only">running</span>}
      </div>
    );
  }

  return (
    <Collapsible>
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground group flex w-full items-center gap-1.5 py-0.5 text-start transition-colors">
        {summary}
        <ChevronRight
          className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="bg-muted text-muted-foreground mt-1 mb-1.5 max-h-64 overflow-auto rounded-md p-2.5 text-xs whitespace-pre-wrap">
          {tool.output}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
};
