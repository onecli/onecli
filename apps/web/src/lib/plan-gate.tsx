"use client";

import type { ReactNode } from "react";

export interface PlanGate {
  /** Whether `feature` is locked for the current plan (drives the upfront lock UI). */
  isLocked: (feature: string) => boolean;
  /**
   * Call when the user selects a gated feature. If locked, opens the upgrade
   * paywall and returns `true` (the caller should abort the selection); returns
   * `false` when the caller should proceed.
   */
  guard: (feature: string) => boolean;
}

const OSS_GATE: PlanGate = {
  isLocked: () => false,
  guard: () => false,
};

/**
 * OSS default: nothing is gated. The cloud edition overrides this module via the
 * `@/lib/plan-gate` turbopack alias (see next.config.js) to gate premium
 * features behind paid plans.
 */
export const usePlanGate = (): PlanGate => OSS_GATE;

/** OSS default: pass-through. Cloud renders the shared paywall dialog + context. */
export const PlanGateProvider = ({ children }: { children: ReactNode }) => (
  <>{children}</>
);
