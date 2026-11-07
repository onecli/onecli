/**
 * The Activity Runs tab's filters: the one list, shared by the tab (its
 * segmented control), the Activity URL (`?view=`, validated here) and the
 * links that open Runs on a filter.
 */
export const RUNS_VIEWS = [
  "all",
  "web",
  "slack",
  "cron",
  "webhook",
  "eval",
  "failed",
] as const;
export type RunsView = (typeof RUNS_VIEWS)[number];

export const isRunsView = (value: string | null): value is RunsView =>
  RUNS_VIEWS.some((view) => view === value);
