"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@onecli/ui/components/collapsible";

export interface InactiveConnectionsProps {
  count: number;
  /** What the folded rows are, for the heading ("connections", "secrets"). */
  noun: string;
  children: ReactNode;
}

/**
 * The agent's connections that exist in the workspace but are switched off
 * for it, folded away by default so the list shows what the agent actually
 * uses. One click unfolds them, where each keeps its switch.
 */
export const InactiveConnections = ({
  count,
  noun,
  children,
}: InactiveConnectionsProps) => {
  if (count === 0) return null;

  return (
    <Collapsible className="mt-2 border-t">
      <CollapsibleTrigger className="group text-muted-foreground hover:text-foreground focus-visible:ring-ring flex w-full items-center gap-2 rounded-sm py-3 text-left text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none">
        <ChevronRight
          className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
          aria-hidden
        />
        Inactive {noun}
        <span className="bg-muted rounded-full px-1.5 text-[11px] tabular-nums">
          {count}
        </span>
        <span className="text-muted-foreground/70 ml-auto text-xs font-normal">
          Available, but off for this agent
        </span>
      </CollapsibleTrigger>
      {/* Same column as the active rows above: no inset, so icons, names
          and switches line up. */}
      <CollapsibleContent className="divide-y border-t">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
};
