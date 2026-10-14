"use client";

import type { ReactNode } from "react";
import type { Users } from "lucide-react";

export interface ContactGroupProps {
  icon: typeof Users;
  title: string;
  description: ReactNode;
  /** Shown when the group has no rows. */
  empty?: string;
  /** Rendered above the rows inside the box (column labels). */
  header?: ReactNode;
  rows: ReactNode[];
}

/** One kind's group: heading, one-line description, the rows or the empty
 *  line. `rows` is an explicit array so "empty" is a count, not a guess. */
export const ContactGroup = ({
  icon: Icon,
  title,
  description,
  empty,
  header,
  rows,
}: ContactGroupProps) => (
  <section className="space-y-2">
    <div className="flex items-center gap-2">
      <Icon className="text-muted-foreground size-4" aria-hidden />
      <h2 className="text-sm font-medium">{title}</h2>
    </div>
    <p className="text-muted-foreground text-xs text-pretty">{description}</p>
    {rows.length === 0 ? (
      empty !== undefined && (
        <p className="text-muted-foreground rounded-md border border-dashed px-3 py-3 text-sm">
          {empty}
        </p>
      )
    ) : (
      <div className="rounded-md border px-3">
        {header}
        <div className="divide-y">{rows}</div>
      </div>
    )}
  </section>
);
