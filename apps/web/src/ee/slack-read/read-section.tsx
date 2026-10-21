"use client";

import { Children, type ReactNode } from "react";
import type { Hash } from "lucide-react";

export interface ReadSectionProps {
  icon: typeof Hash;
  title: string;
  /** Shown beside the title (rows in the group). */
  count?: number;
  description?: string;
  /** Shown in a dashed box when there are no children. */
  empty?: string;
  /** Render children as-is (no bordered row list). */
  bare?: boolean;
  children?: ReactNode;
}

/**
 * One group of the read card, in the Contacts page's shape: icon + heading
 * (+ count), a one-line description, then its rows in one bordered,
 * divided list, or a dashed empty line. Same eye path as Contacts, so the
 * two pages read alike.
 */
export const ReadSection = ({
  icon: Icon,
  title,
  count,
  description,
  empty,
  bare = false,
  children,
}: ReadSectionProps) => {
  const rows = Children.toArray(children);
  return (
    <section className="space-y-2">
      <div className="space-y-0.5">
        <div className="flex items-center gap-2">
          <Icon className="text-muted-foreground size-4" aria-hidden />
          <h3 className="text-sm font-medium">{title}</h3>
          {count !== undefined && (
            <span className="text-muted-foreground text-xs tabular-nums">
              {count}
            </span>
          )}
        </div>
        {description && (
          <p className="text-muted-foreground text-xs text-pretty">
            {description}
          </p>
        )}
      </div>
      {bare ? (
        children
      ) : rows.length > 0 ? (
        <div className="divide-y rounded-md border px-3">{rows}</div>
      ) : empty ? (
        <p className="text-muted-foreground rounded-md border border-dashed px-3 py-2.5 text-sm">
          {empty}
        </p>
      ) : null}
    </section>
  );
};
