"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import type { BillingInterval, Plan } from "@onecli/api/ee/billing/plans";
import { apiPost } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";

export interface PlanSwitchPreview {
  /**
   * The switch cannot happen in place (card-less trial): confirming sends
   * the customer through Stripe Checkout to enter payment details.
   */
  requiresCheckout: boolean;
  amountDueTodayCents: number;
  currency: string;
  newPriceCents: number;
  interval: BillingInterval;
  renewsAt: string | null;
  prorationDate: number;
  pendingCancellationCleared: boolean;
  trialing: boolean;
}

export const usePlanSwitchPreview = (
  plan: Plan | null,
  interval: BillingInterval,
) =>
  useQuery({
    queryKey: queryKeys.billing.prorationPreview(plan ?? "none", interval),
    queryFn: () =>
      apiPost<PlanSwitchPreview>("/v1/billing/checkout/preview", {
        plan,
        interval,
      }),
    enabled: !!plan,
    // Always re-quote on open: a cached preview carries a stale
    // prorationDate, so the shown amount could drift from the real charge.
    staleTime: 0,
    gcTime: 0,
    retry: 1,
  });

interface SwitchPlanInput {
  plan: Plan;
  interval: BillingInterval;
  prorationDate: number;
}

export const useSwitchPlan = () =>
  useMutation({
    mutationFn: (input: SwitchPlanInput) =>
      apiPost<{ switched?: boolean; checkout_url?: string }>(
        "/v1/billing/checkout",
        input,
      ),
    onSuccess: (data) => {
      // If the subscription vanished between preview and confirm (e.g.
      // canceled in another tab), the API falls back to a Stripe Checkout
      // session — follow it instead of reloading into a broken state.
      if (!data.switched && data.checkout_url) {
        window.location.href = data.checkout_url;
        return;
      }
      // Full reload so the plan badge, cards, and quotas all reflect the
      // new plan (matches the pre-existing switch behavior).
      window.location.reload();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to switch plan");
    },
  });
