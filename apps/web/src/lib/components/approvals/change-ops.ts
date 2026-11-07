import type { ShownOp } from "@onecli/api/lib/record-change";

/** The web's color per kind of change (the words and order are shared with
 *  Slack, in `@onecli/api/lib/record-change`). Color is never the only cue
 *  (WCAG 1.4.1): every cell also says it in words. */
export const CHANGE_COLORS: Record<ShownOp, { dot: string; cell: string }> = {
  clear: {
    dot: "bg-red-500",
    cell: "bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200",
  },
  overwrite: {
    dot: "bg-blue-500",
    cell: "bg-blue-50 text-blue-900 dark:bg-blue-950/40 dark:text-blue-200",
  },
  fill: {
    dot: "bg-emerald-500",
    cell: "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
  },
  same: {
    dot: "bg-muted-foreground/40",
    cell: "text-muted-foreground",
  },
};
