"use client";

import Link from "next/link";
import {
  ArrowRight,
  ExternalLink,
  Gauge,
  Globe,
  Hand,
  Shield,
  Users,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";
import { Button } from "@onecli/ui/components/button";
import {
  PLANS,
  RETIRED_PLANS,
  getPlanConfig,
  isPlanAtLeast,
  isSalesManagedPlan,
} from "@onecli/api/ee/billing/plans";
import {
  requiredPlanFor,
  type PremiumFeature,
} from "@onecli/api/ee/billing/plan-features";
import { generateOrgPrefix } from "@/lib/org-navigation";
import { useGuardedUpgrade } from "../use-guarded-upgrade";
import { PlanSwitchDialog } from "./plan-switch-dialog";
import { UpgradeDialogShell } from "@/lib/components/upgrade-dialog-shell";

interface FeatureContent {
  icon: LucideIcon;
  iconClassName: string;
  title: string;
  description: string;
}

const FEATURE_CONTENT: Record<PremiumFeature, FeatureContent> = {
  "policy.manual_approval": {
    icon: Hand,
    iconClassName: "text-blue-500",
    title: "Manual approval",
    description:
      "Requiring human approval before an agent acts is a paid feature. Upgrade to gate sensitive actions behind approval.",
  },
  "policy.rate_limit": {
    icon: Gauge,
    iconClassName: "text-amber-500",
    title: "Rate limiting",
    description:
      "Throttling how many requests an agent can make is a paid feature. Upgrade to rate limit agent traffic.",
  },
  "policy.deny_mode": {
    icon: Shield,
    iconClassName: "text-brand",
    title: "Deny by default",
    description:
      "Deny-by-default blocks all agent traffic unless a rule explicitly allows it. Upgrade to lock down your agents by default.",
  },
  sso: {
    icon: Globe,
    iconClassName: "text-brand",
    title: "Verified domains & SSO",
    description:
      "Claiming email domains and single sign-on are part of the Enterprise plan.",
  },
  groups: {
    icon: Users,
    iconClassName: "text-brand",
    title: "Groups",
    description:
      "Organizing members into groups is part of the Enterprise plan.",
  },
};

interface PlanPaywallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Gated feature to present; `null` only before the dialog is first opened. */
  feature: PremiumFeature | null;
  organizationId: string | null;
}

export const PlanPaywallDialog = ({
  open,
  onOpenChange,
  feature,
  organizationId,
}: PlanPaywallDialogProps) => {
  const {
    startUpgrade,
    checkoutLoading,
    switchTo,
    switchInterval,
    closeSwitchDialog,
  } = useGuardedUpgrade();

  if (!feature) return null;

  const content = FEATURE_CONTENT[feature];
  const ContentIcon = content.icon;
  const required = requiredPlanFor(feature);

  // When exactly one plan unlocks the feature, upgrade to it directly; when
  // several do send the user to billing to choose. Retired plans are never
  // offered, so they neither count as the single unlock nor appear in the
  // pill — a free org gated on a "pro" feature must see Team (the cheapest
  // plan it can actually buy), not the retired Pro.
  const unlocking = PLANS.filter(
    (p) => !RETIRED_PLANS.includes(p.id) && isPlanAtLeast(p.id, required),
  );
  const directPlan = unlocking.length === 1 ? unlocking[0]!.id : null;
  // Cheapest offered unlocking plan (PLANS is rank-ordered). Sales-managed
  // tiers keep their own name: enterprise isn't in PLANS, so unlocking is
  // empty and the pill falls back to the required plan itself.
  const displayPlan = unlocking[0]?.id ?? required;
  const billingHref = `${generateOrgPrefix(organizationId ?? "")}/billing`;

  // Sales-managed tiers (enterprise) have no self-serve upgrade path — route
  // to sales instead of checkout/billing.
  const footer = isSalesManagedPlan(required) ? (
    <Button asChild variant="brand" className="w-full">
      <a
        href="https://onecli.sh/contact?utm_source=paywall"
        target="_blank"
        rel="noopener noreferrer"
      >
        Contact Sales
        <ExternalLink className="size-3.5" />
      </a>
    </Button>
  ) : directPlan ? (
    <Button
      variant="brand"
      className="w-full"
      loading={checkoutLoading}
      onClick={() => startUpgrade(directPlan)}
    >
      {checkoutLoading
        ? "Redirecting..."
        : `Upgrade to ${getPlanConfig(directPlan).name}`}
      {!checkoutLoading && <ArrowRight className="size-3.5" />}
    </Button>
  ) : (
    <Button asChild variant="brand" className="w-full">
      <Link href={billingHref} onClick={() => onOpenChange(false)}>
        Upgrade now
        <ArrowRight className="size-3.5" />
      </Link>
    </Button>
  );

  return (
    <>
      <UpgradeDialogShell
        open={open}
        onOpenChange={onOpenChange}
        icon={<ContentIcon className={cn("size-6", content.iconClassName)} />}
        title={content.title}
        pill={getPlanConfig(displayPlan).name}
        description={content.description}
        footer={footer}
      />
      <PlanSwitchDialog
        plan={switchTo}
        initialInterval={switchInterval}
        onClose={closeSwitchDialog}
      />
    </>
  );
};
