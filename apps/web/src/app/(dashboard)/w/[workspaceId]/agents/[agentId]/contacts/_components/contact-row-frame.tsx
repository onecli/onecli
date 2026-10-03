"use client";

import type { ReactNode } from "react";
import { MoreHorizontal, Trash2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";

interface ContactRowFrameProps {
  /** The contact's name. Rendered `translate="no"`: an identifier. */
  label: string;
  /** Monospace for provider identifiers (#channel), plain for names. */
  mono?: boolean;
  /** The row's standing decision: a badge, or a badge-as-trigger menu. */
  status: ReactNode;
  /**
   * Items for the `…` menu, before Remove. Remove is always last, always
   * destructive-styled, always behind the caller's confirm dialog.
   */
  actions?: {
    label: string;
    icon: ReactNode;
    onSelect: () => void;
    disabled?: boolean;
  }[];
  /** Opens the caller's confirm dialog; the frame never deletes. Omit for
   *  rows nothing can remove (the members line). */
  onRemove?: () => void;
  disabled?: boolean;
}

/**
 * The ONE row shape every Contacts group uses, so a person's eye lands on
 * the same three columns on every line: who, their standing, and a single
 * quiet `…` that holds everything else. The badge is the reading; the
 * menu behind it (when the row has one) is the changing. Remove lives in
 * the `…` as its last, destructive item rather than as a per-row X: one
 * affordance for "more", one place for the irreversible thing.
 */
export const ContactRowFrame = ({
  label,
  mono = false,
  status,
  actions = [],
  onRemove,
  disabled = false,
}: ContactRowFrameProps) => {
  const hasMenu = actions.length > 0 || onRemove !== undefined;
  return (
    <div className="flex min-h-11 items-center gap-3 py-1.5">
      <span
        className={`min-w-0 flex-1 truncate text-sm ${mono ? "font-mono" : ""}`}
        translate="no"
      >
        {label}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        {status}
        {hasMenu ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={disabled}>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`More for ${label}`}
              >
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
          // Keep the column: a row with nothing more to offer still lines
          // up its badge with its neighbours'.
          <span className="size-9" aria-hidden />
        )}
      </div>
    </div>
  );
};
