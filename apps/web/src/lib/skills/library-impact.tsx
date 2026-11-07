"use client";

import { Bot, Sparkles } from "lucide-react";
import type { LibraryUsage } from "@/lib/api";

/** How many names to show before "+N more". */
const SHOWN_NAMES = 6;

export interface LibraryImpactProps {
  usage: LibraryUsage;
}

/**
 * What a switch or disconnect takes away, at a glance: two counts, then the
 * skill names as code chips (the first few, "+N more" for the rest). Shared
 * by both confirms so they describe the loss the same way.
 */
export const LibraryImpact = ({ usage }: LibraryImpactProps) => {
  const shown = usage.skillNames.slice(0, SHOWN_NAMES);
  const more = usage.skillNames.length - shown.length;
  const skills = usage.skillNames.length;
  return (
    <div className="border-destructive/25 bg-destructive/5 space-y-2.5 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="flex items-center gap-1.5 font-medium">
          <Sparkles className="text-destructive size-4" aria-hidden />
          {skills} library skill{skills === 1 ? "" : "s"}
        </span>
        <span className="flex items-center gap-1.5 font-medium">
          <Bot className="text-destructive size-4" aria-hidden />
          {usage.agentCount} agent{usage.agentCount === 1 ? "" : "s"}
        </span>
      </div>
      <ul
        className="flex flex-wrap gap-1.5"
        aria-label="Skills that will be removed"
      >
        {shown.map((name) => (
          <li
            key={name}
            className="bg-background rounded border px-1.5 py-0.5 font-mono text-xs"
          >
            {name}
          </li>
        ))}
        {more > 0 && (
          <li className="text-muted-foreground px-1 py-0.5 text-xs">
            +{more} more
          </li>
        )}
      </ul>
    </div>
  );
};
