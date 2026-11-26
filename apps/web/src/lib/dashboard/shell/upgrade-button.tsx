"use client";

import Link from "next/link";
import { Button } from "@onecli/ui/components/button";
import { useOrgMembership } from "@/hooks/use-org";
import { useSettingsHref } from "@/lib/settings-modal/use-settings-href";
import { usePlanUsage } from "@/ee/billing/use-plan-usage";
import {
  isSalesManagedPlan,
  normalizePlan,
} from "@onecli/api/ee/billing/plans";
import { CAPS } from "@/lib/env";

/**
 * Upgrade: outlined, on free and self-serve plans, for the org's admins
 * (Billing is an admin page: a member's click would open nothing). Gone on
 * sales-managed plans (enterprise), where the plan shows only in
 * Settings > Billing, and on editions without billing. Green text is
 * `brand-ink`, the shade that reads at 4.5:1; `brand` is for fills.
 */
export const UpgradeButton = () => {
  const usage = usePlanUsage();
  const { data: membership } = useOrgMembership();
  const settingsHref = useSettingsHref();
  if (!CAPS.billing || !usage || !membership?.isAdmin) return null;
  if (isSalesManagedPlan(normalizePlan(usage.plan))) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      className="border-brand/30 text-brand-ink hover:bg-brand/10 hover:text-brand-ink"
      asChild
    >
      <Link href={settingsHref("billing")}>Upgrade</Link>
    </Button>
  );
};
