"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { extractOrgId } from "@/lib/org-navigation";
import { WORKSPACE_PATH_RE } from "@/lib/navigation";
import { getPlanUsage, type PlanUsage } from "./api-request-actions";
import { CAPS } from "@/lib/env";

export const QUOTA_WARNING_THRESHOLD = 0.8;

// Hard caps that grandfathered orgs may legitimately exceed (agents from
// earlier cap tightenings, members/seats from the July-2026 caps). For PAID
// plans that's an accepted state — creation and invites are blocked, nothing
// else is — so a permanent "over plan limits" banner or an Upgrade badge
// would punish paying customers. Free orgs still get flagged (the upgrade
// nudge). The billing usage page deliberately keeps showing the raw numbers.
const GRANDFATHERED_HARD_CAPS = new Set(["Agents", "Members"]);

/** Whether a resource should surface as "over plan limits" in banner/badge UI. */
export const isFlaggedOverLimit = (
  resource: { name: string; current: number; limit: number },
  plan: string,
): boolean =>
  resource.limit !== Infinity &&
  resource.current > resource.limit &&
  !(GRANDFATHERED_HARD_CAPS.has(resource.name) && plan !== "free");

export const usePlanUsage = () => {
  const pathname = usePathname();
  const routeKey =
    extractOrgId(pathname) ??
    pathname.match(WORKSPACE_PATH_RE)?.[1] ??
    "default";
  const queryClient = useQueryClient();

  const { data } = useQuery<PlanUsage>({
    queryKey: ["billing", "planUsage", routeKey],
    queryFn: getPlanUsage,
    // Billing-less editions never fetch plan usage.
    enabled: CAPS.billing,
  });

  useEffect(() => {
    if (!window.location.search.includes("checkout=success")) return;
    const timer = setTimeout(() => {
      queryClient.invalidateQueries({
        queryKey: ["billing", "planUsage", routeKey],
      });
    }, 3000);
    return () => clearTimeout(timer);
  }, [queryClient, routeKey]);

  return data ?? null;
};
