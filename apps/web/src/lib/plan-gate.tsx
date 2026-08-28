"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";
import { isPlanAtLeast } from "@onecli/api/ee/billing/plans";
import {
  isPremiumFeature,
  requiredPlanFor,
  type PremiumFeature,
} from "@onecli/api/ee/billing/plan-features";
import {
  isEnterpriseFeature,
  type EnterpriseFeature,
} from "@onecli/api/lib/entitlements";
import { usePlanUsage } from "@/ee/billing/use-plan-usage";
import { useInstance } from "@/hooks/use-instance";

// Loaded lazily and only rendered once a locked feature was actually hit, so
// the checkout UI (Stripe graph) stays out of every dashboard page's chunk.
const PlanPaywallDialog = dynamic(
  () =>
    import("@/ee/billing/_components/plan-paywall-dialog").then(
      (m) => m.PlanPaywallDialog,
    ),
  { ssr: false },
);

// Same lazy treatment for the self-host license dialog.
const LicenseRequiredDialog = dynamic(
  () =>
    import("@/lib/components/license-required-dialog").then(
      (m) => m.LicenseRequiredDialog,
    ),
  { ssr: false },
);

export interface PlanGate {
  /** Whether `feature` is locked for this org/instance (drives the upfront lock UI). */
  isLocked: (feature: string) => boolean;
  /**
   * Call when the user selects a gated feature. If locked, opens the matching
   * dialog — the billing paywall on cloud, the enterprise-license dialog on
   * self-host — and returns `true` (the caller should abort the selection);
   * returns `false` when the caller should proceed.
   */
  guard: (feature: string) => boolean;
}

const NOOP_GATE: PlanGate = { isLocked: () => false, guard: () => false };

const PlanGateContext = createContext<PlanGate>(NOOP_GATE);

/**
 * Provides the feature gate to the dashboard and renders the single shared
 * lock dialog. Mounted once (see the dashboard layout) so consumers call
 * `usePlanGate()` and never wire their own dialog.
 *
 * Two locks compose, and each disarms itself off its own turf:
 * - PLAN lock (cloud): `usePlanUsage` never fetches without `CAPS.billing`,
 *   so `plan` stays null on self-host and nothing plan-locks.
 * - LICENSE lock (self-host): `/v1/instance` reports `entitled: true` on
 *   cloud (and on a licensed self-host), so nothing license-locks there.
 *
 * While either source is still loading (null) its lock is OFF — paying/
 * licensed users are never falsely gated; the server stays the source of
 * truth.
 */
export const PlanGateProvider = ({ children }: { children: ReactNode }) => {
  const usage = usePlanUsage();
  const plan = usage?.plan ?? null;
  const instance = useInstance();

  const [open, setOpen] = useState(false);
  const [feature, setFeature] = useState<
    | { kind: "plan"; feature: PremiumFeature }
    | { kind: "license"; feature: EnterpriseFeature }
    | null
  >(null);

  const planLocked = useCallback(
    (f: string) =>
      isPremiumFeature(f) &&
      plan !== null &&
      !isPlanAtLeast(plan, requiredPlanFor(f)),
    [plan],
  );

  const licenseLocked = useCallback(
    (f: string) =>
      isEnterpriseFeature(f) && instance !== null && !instance.entitled,
    [instance],
  );

  const isLocked = useCallback(
    (f: string) => planLocked(f) || licenseLocked(f),
    [planLocked, licenseLocked],
  );

  const guard = useCallback(
    (f: string) => {
      // planLocked() implies a known premium feature; licenseLocked() a known
      // enterprise feature.
      if (planLocked(f)) {
        setFeature({ kind: "plan", feature: f as PremiumFeature });
        setOpen(true);
        return true;
      }
      if (licenseLocked(f)) {
        setFeature({ kind: "license", feature: f as EnterpriseFeature });
        setOpen(true);
        return true;
      }
      return false;
    },
    [planLocked, licenseLocked],
  );

  const gate = useMemo<PlanGate>(
    () => ({ isLocked, guard }),
    [isLocked, guard],
  );

  return (
    <PlanGateContext.Provider value={gate}>
      {children}
      {feature?.kind === "plan" && (
        <PlanPaywallDialog
          open={open}
          onOpenChange={setOpen}
          feature={feature.feature}
          organizationId={usage?.organizationId ?? null}
        />
      )}
      {feature?.kind === "license" && (
        <LicenseRequiredDialog
          open={open}
          onOpenChange={setOpen}
          feature={feature.feature}
        />
      )}
    </PlanGateContext.Provider>
  );
};

export const usePlanGate = (): PlanGate => useContext(PlanGateContext);
