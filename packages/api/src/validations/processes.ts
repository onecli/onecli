/**
 * Control-plane unions + caps for background processes and watches (step 10).
 *
 * Unlike crons/memory, the tool ARGS are validated supervisor-side (the tools
 * are locally executed), so there is no request-body zod here. What lives
 * here is the vocabulary the control-plane services and the state-machine
 * guards read, plus the availability caps documented for the reviewer — the
 * supervisor enforces them exactly (one supervisor per sandbox), these are
 * the same numbers named where the CP reasons about them.
 */

export const PROCESS_STATUSES = [
  "running",
  "exited",
  "stopped",
  "lost",
] as const;
export type ProcessStatus = (typeof PROCESS_STATUSES)[number];

export const WATCH_KINDS = ["exit", "pattern", "silence"] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];

export const WATCH_STATUSES = [
  "armed",
  "triggered",
  "fired",
  "expired",
  "canceled",
] as const;
export type WatchStatus = (typeof WATCH_STATUSES)[number];

export const WATCH_TRIGGERS = ["exited", "matched", "silent", "lost"] as const;
export type WatchTrigger = (typeof WATCH_TRIGGERS)[number];

/** Availability bounds (the MAX_CRONS_PER_AGENT reasoning). Enforced in the
 * supervisor's process manager; named here so the CP's reasoning cites one
 * source of truth. */
export const MAX_PROCESSES_PER_SANDBOX = 5;
export const MAX_WATCHES_PER_PROCESS = 3;
