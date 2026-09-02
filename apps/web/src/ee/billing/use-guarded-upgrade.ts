"use client";

import { useState } from "react";
import {
  getPlanConfig,
  isPaidPlan,
  type BillingInterval,
  type Plan,
  type PlanConfig,
} from "@onecli/api/ee/billing/plans";
import { useCheckout } from "@/ee/billing/use-checkout";
import { usePlanUsage } from "@/ee/billing/use-plan-usage";
import { useSubscriptionStatus } from "@/ee/billing/use-subscription-status";

/**
 * Upgrade entry-point policy: paid→paid switches must show the proration
 * preview (PlanSwitchDialog) before anything is charged, while free→paid
 * keeps the direct Stripe Checkout redirect (Checkout is its own
 * confirmation surface).
 *
 * Consumers call `startUpgrade(plan)` from their CTA and render
 * `<PlanSwitchDialog plan={switchTo} interval={switchInterval}
 * onClose={closeSwitchDialog} />` as a sibling.
 *
 * Switches keep the org's current billing interval (a yearly customer
 * upgrading a plan stays yearly); free→paid starts monthly — the billing
 * page is where an interval is chosen.
 *
 * @param knownCurrentPlan Server-derived current plan when the caller has
 * one; otherwise the cached plan usage is consulted. If the plan is still
 * unknown (cache-cold first paint), the direct checkout path is used — the
 * backend bills the switch correctly either way.
 */
export const useGuardedUpgrade = (knownCurrentPlan?: Plan | null) => {
  const { checkout, loading: checkoutLoading } = useCheckout();
  const usagePlan = usePlanUsage()?.plan ?? null;
  const subscription = useSubscriptionStatus();
  const [switchTo, setSwitchTo] = useState<PlanConfig | null>(null);

  const currentPlan = knownCurrentPlan ?? usagePlan;
  const switchInterval: BillingInterval = subscription?.interval ?? "month";

  const startUpgrade = (plan: Plan) => {
    if (currentPlan && isPaidPlan(currentPlan)) {
      setSwitchTo(getPlanConfig(plan));
    } else {
      checkout(plan);
    }
  };

  return {
    startUpgrade,
    checkoutLoading,
    switchTo,
    switchInterval,
    closeSwitchDialog: () => setSwitchTo(null),
  };
};
