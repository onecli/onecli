"use client";

import type { ReactNode } from "react";

export interface DirectionCellProps {
  /** The column's question, e.g. "Can message Donna". Visible on narrow
   *  screens, where the group's column header is hidden. */
  heading: string;
  children: ReactNode;
}

/**
 * One direction's slot on a two-way row. Fixed width so every row's badge
 * sits under its group's column header; the heading repeats inline only on
 * narrow screens, where the shared header row is hidden.
 */
export const DirectionCell = ({ heading, children }: DirectionCellProps) => (
  <div className="flex flex-col items-end sm:w-40">
    <span className="text-muted-foreground px-2 text-[11px] sm:hidden">
      {heading}
    </span>
    {children}
  </div>
);
