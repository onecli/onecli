"use client";

import { useQuery } from "@tanstack/react-query";
import { isPlanAtLeast, normalizePlan } from "@onecli/api/ee/billing/plans";
import { queryKeys } from "@/lib/api/keys";
import { getCurrentPlan } from "@/lib/user-plan";

/**
 * Whether the org's plan includes granular access (team tier or above), for
 * the pickers' Save-vs-Upgrade choice. Entitlement comes through the shared
 * user-plan seam (cloud → the real plan; null where billing is off).
 *
 * Optimistic: `true` until a DEFINITE plan says otherwise — while it loads,
 * where billing is off, and when the plan read fails (`getCurrentPlan`
 * returns null on error) — so a paying customer never sees an upgrade CTA
 * flash. The server enforces the entitlement on save regardless.
 */
export const useHasTeamFeatures = (): boolean => {
  const { data: plan } = useQuery({
    queryKey: queryKeys.userPlan.all(),
    queryFn: getCurrentPlan,
    staleTime: 5 * 60_000,
  });
  return plan == null || isPlanAtLeast(normalizePlan(plan), "team");
};
