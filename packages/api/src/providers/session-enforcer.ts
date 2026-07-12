import type { SessionEnforcer } from "./types";

let _sessionEnforcer: SessionEnforcer | null = null;

/** Null resets to the default (no enforcement) — used by tests. */
export const initSessionEnforcer = (e: SessionEnforcer | null) => {
  _sessionEnforcer = e;
};

export const getSessionEnforcer = (): SessionEnforcer | null =>
  _sessionEnforcer;
