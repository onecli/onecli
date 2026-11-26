import type { ReactNode } from "react";

/** A `…` menu item a contact row shows (the ContactRowFrame shape). */
export interface ContactRowAction {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}

/** The two "as you" cells of one contact row. */
export interface AsYouCells {
  /** "Reads as you": a tri-state, an Enable button, or a dash. */
  reads: ReactNode;
  /** "Writes as you": a tri-state or a dash. */
  writes: ReactNode;
}

/** What "acts as you" adds to one contact row. */
export interface ActAsYouRowExtras {
  cells: AsYouCells;
  /** Extra `…` items ("Stop acting as you here"). */
  actions: ContactRowAction[];
}

export type ActAsYouGroup = "people" | "channels";

/**
 * The seam between the free Contacts list and the licensed "acts as you"
 * layer (`@/ee/slack-read/act-as-you-contacts`). Free code only ever sees
 * this shape; unentitled, it is EMPTY_ACT_AS_YOU and renders nothing (no
 * columns at all).
 */
export interface ActAsYouSlot {
  /** Show the "Reads as you" / "Writes as you" columns. */
  columns: boolean;
  /** The line at the top: your Slack, and Share conversations. */
  header: ReactNode;
  /** Extras for a contact row, keyed on its provider id. */
  forRow: (
    group: ActAsYouGroup,
    ref: string,
    label: string,
  ) => ActAsYouRowExtras | null;
  /** Shared conversations with no contact row in this group. */
  standaloneRows: (group: ActAsYouGroup, contactRefs: string[]) => ReactNode[];
}

export const EMPTY_ACT_AS_YOU: ActAsYouSlot = {
  columns: false,
  header: null,
  forRow: () => null,
  standaloneRows: () => [],
};
