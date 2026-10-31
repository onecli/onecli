"use client";

import { useState, type ReactNode } from "react";
import { Info, type Users } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import {
  AGENT_CELL,
  AS_YOU_FIRST_CELL,
  AS_YOU_GRID,
  MENU_CELL,
  WRITE_CELL,
} from "./contact-grid";

export interface ContactGroupProps {
  icon: typeof Users;
  title: string;
  /** What the group is, behind an info icon next to the title. */
  description: ReactNode;
  /** Shown when the group has no rows. */
  empty?: string;
  rows: ReactNode[];
  /** The table header (licensed "as you" columns): the agent's name for
   *  "Talks to <Agent>". Absent = no header row (today's layout). */
  asYouHeaderFor?: string;
}

/** One kind's group: heading (its explanation behind an info icon), then
 *  the rows or the empty line. `rows` is an explicit array so "empty" is a
 *  count, not a guess. */
export const ContactGroup = ({
  icon: Icon,
  title,
  description,
  empty,
  rows,
  asYouHeaderFor,
}: ContactGroupProps) => {
  // Controlled so a tap opens it too: a hover-only tooltip never shows on
  // touch screens (the billing InfoTip pattern).
  const [infoOpen, setInfoOpen] = useState(false);
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Icon className="text-muted-foreground size-4" aria-hidden />
        <h2 className="text-sm font-medium">{title}</h2>
        <Tooltip open={infoOpen} onOpenChange={setInfoOpen}>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm focus-visible:ring-2 focus-visible:outline-none"
              aria-label={`About ${title}`}
              onClick={() => setInfoOpen((open) => !open)}
            >
              <Info className="size-3.5" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-xs text-pretty">
            {description}
          </TooltipContent>
        </Tooltip>
      </div>
      {rows.length === 0 ? (
        empty !== undefined && (
          <p className="text-muted-foreground rounded-md border border-dashed px-3 py-3 text-sm">
            {empty}
          </p>
        )
      ) : (
        <div className="divide-y rounded-md border px-3">
          {asYouHeaderFor !== undefined && (
            <div
              className={cn(
                AS_YOU_GRID,
                "text-muted-foreground hidden text-xs md:grid [&>span]:py-2",
              )}
              data-testid="contact-table-header"
            >
              <span />
              <span className={cn(AGENT_CELL, "self-stretch px-4 font-medium")}>
                Can talk with <span translate="no">{asYouHeaderFor}</span>
              </span>
              <span
                className={cn(
                  AS_YOU_FIRST_CELL,
                  "self-stretch px-4 font-medium",
                )}
              >
                Read history
              </span>
              <span className={cn(WRITE_CELL, "self-stretch px-4 font-medium")}>
                Write for you
              </span>
              <span className={cn(MENU_CELL, "self-stretch")} />
            </div>
          )}
          {rows}
        </div>
      )}
    </section>
  );
};
