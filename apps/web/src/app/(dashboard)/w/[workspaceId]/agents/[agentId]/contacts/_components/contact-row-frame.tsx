"use client";

import type { ReactNode } from "react";
import { MoreHorizontal, Trash2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import type { AsYouCells, ContactRowAction } from "./act-as-you-slot";
import {
  AGENT_CELL,
  AS_YOU_FIRST_CELL,
  AS_YOU_GRID,
  MENU_CELL,
  WRITE_CELL,
} from "./contact-grid";

interface ContactRowFrameProps {
  /** The contact's name. Rendered `translate="no"`: an identifier. */
  label: string;
  /** Monospace for provider identifiers (#channel), plain for names. */
  mono?: boolean;
  /** A quiet second line under the name ("Workspace owner"). */
  subtitle?: string | null;
  /** A small mark before the name (a person's photo, an agent's avatar). */
  leading?: ReactNode;
  /** The row's one setting: the Always allow / Never icons, or a badge
   * saying where an open ask waits. */
  status: ReactNode;
  /**
   * Items for the `…` menu, before Remove. Remove is always last, always
   * destructive-styled, always behind the caller's confirm dialog.
   */
  actions?: ContactRowAction[];
  /** Opens the caller's confirm dialog; the frame never deletes. Omit for
   *  rows with nothing to remove (a pending ask, which the bell owns). */
  onRemove?: () => void;
  disabled?: boolean;
  /** The "as you" cells (licensed). Given = the table layout with its
   *  aligned columns; absent = today's plain row. */
  asYou?: AsYouCells;
}

/**
 * The ONE row shape every Contacts group uses, so the eye lands on the same
 * columns on every line: who, their one setting, and a single quiet `…`
 * that holds everything else. Remove lives in the `…` as its last,
 * destructive item rather than as a per-row X: one affordance for "more",
 * one place for the irreversible thing.
 */
export const ContactRowFrame = ({
  label,
  mono = false,
  subtitle = null,
  leading = null,
  status,
  actions = [],
  onRemove,
  disabled = false,
  asYou,
}: ContactRowFrameProps) => {
  const hasMenu = actions.length > 0 || onRemove !== undefined;
  const name = (
    <>
      {leading}
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-sm ${mono ? "font-mono" : ""}`}
          translate="no"
        >
          {label}
        </span>
        {subtitle ? (
          <span
            className="text-muted-foreground block truncate text-xs"
            translate="no"
          >
            {subtitle}
          </span>
        ) : null}
      </span>
    </>
  );
  const menu = hasMenu ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button variant="ghost" size="icon" aria-label={`More for ${label}`}>
          <MoreHorizontal className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.label}
            onSelect={action.onSelect}
            disabled={action.disabled}
          >
            {action.icon}
            {action.label}
          </DropdownMenuItem>
        ))}
        {actions.length > 0 && onRemove !== undefined && (
          <DropdownMenuSeparator />
        )}
        {onRemove !== undefined && (
          <DropdownMenuItem variant="destructive" onSelect={onRemove}>
            <Trash2 className="size-4" aria-hidden />
            Remove
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : (
    // Keep the column: a row with nothing more to offer still lines up its
    // badge with its neighbours'.
    <span className="size-9" aria-hidden />
  );

  if (asYou) {
    return (
      <div
        className={cn(AS_YOU_GRID, "min-h-12 gap-y-1 py-1.5 md:py-0")}
        data-testid="contact-row-table"
      >
        <div className="flex min-w-0 items-center gap-3 md:pr-3">{name}</div>
        <div
          className={cn(
            "flex min-w-0 items-center gap-1 md:self-stretch md:px-4",
            AGENT_CELL,
          )}
        >
          {status}
        </div>
        <div className="order-last col-span-3 flex flex-wrap items-center gap-x-4 gap-y-1 pl-0 md:order-none md:col-span-1 md:contents">
          <div
            className={cn(
              "flex min-w-0 items-center gap-1 md:self-stretch md:px-4",
              AS_YOU_FIRST_CELL,
            )}
            data-testid="cell-reads"
          >
            <span className="text-muted-foreground text-xs md:hidden">
              Read history
            </span>
            {asYou.reads}
          </div>
          <div
            className={cn(
              "flex min-w-0 items-center gap-1 md:self-stretch md:px-4",
              WRITE_CELL,
            )}
            data-testid="cell-writes"
          >
            <span className="text-muted-foreground text-xs md:hidden">
              Write for you
            </span>
            {asYou.writes}
          </div>
        </div>
        <div
          className={cn(
            "flex justify-end md:self-stretch md:items-center",
            MENU_CELL,
          )}
        >
          {menu}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-11 items-center gap-3 py-1.5">
      {name}
      <div className="flex shrink-0 items-center gap-1">
        {status}
        {menu}
      </div>
    </div>
  );
};
