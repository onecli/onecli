"use client";

import { useState } from "react";
import {
  Check,
  ArrowRight,
  Link2,
  Building2,
  ExternalLink,
} from "lucide-react";
import { InfoTip } from "@/ee/billing/_components/info-tip";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import { apiFetch } from "@/lib/api-fetch";
import { useCheckout } from "@/ee/billing/use-checkout";
import { PlanSwitchDialog } from "@/ee/billing/_components/plan-switch-dialog";
import { BillingIntervalToggle } from "@/ee/billing/_components/billing-interval-toggle";
import {
  ENTERPRISE_PLAN,
  isPaidPlan,
  isSalesManagedPlan,
  normalizePlan,
  offeredPlans,
  planRank,
} from "@onecli/api/ee/billing/plans";
import type {
  BillingInterval,
  Plan,
  SubscriptionStatus,
  PlanConfig,
} from "@onecli/api/ee/billing/plans";

interface BillingContentProps {
  status: SubscriptionStatus;
  cancelAtPeriodEnd?: boolean;
  /** Billing interval of the active subscription; null when there is none. */
  currentInterval?: BillingInterval | null;
  /** Subscription is sales/ops-managed (enterprise, self-hosted Scale). */
  salesManaged?: boolean;
}

export const BillingContent = ({
  status,
  cancelAtPeriodEnd,
  currentInterval,
  salesManaged,
}: BillingContentProps) => {
  const { checkout } = useCheckout();
  const [portalLoading, setPortalLoading] = useState(false);
  const [loadingPlan, setLoadingPlan] = useState<Plan | null>(null);
  const [switchTarget, setSwitchTarget] = useState<PlanConfig | null>(null);
  const [reactivating, setReactivating] = useState(false);
  // Land paying customers on their own interval so their plan reads "Current".
  // (Setter named to avoid shadowing the global setInterval timer.)
  const [interval, setBillingInterval] = useState<BillingInterval>(
    currentInterval ?? "month",
  );

  const reactivate = async () => {
    setReactivating(true);
    try {
      const res = await apiFetch("/v1/billing/reactivate", { method: "POST" });
      if (!res.ok) throw new Error();
      window.location.reload();
    } catch {
      toast.error("Failed to reactivate subscription");
      setReactivating(false);
    }
  };

  const currentPlan: Plan = normalizePlan(status);

  // Retired plans (pro) render only for orgs still on them.
  const plans = offeredPlans(currentPlan);

  const openPortal = async () => {
    setPortalLoading(true);
    try {
      const res = await apiFetch("/v1/billing/portal", { method: "POST" });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to open billing portal");
      }

      window.location.href = data.portal_url;
    } catch {
      toast.error("Failed to open billing portal");
      setPortalLoading(false);
    }
  };

  const handlePlanAction = (plan: PlanConfig) => {
    if (isPaidPlan(currentPlan)) {
      setSwitchTarget(plan);
    } else {
      setLoadingPlan(plan.id);
      checkout(plan.id, interval);
    }
  };

  return (
    <>
      <div className="flex justify-center md:justify-end">
        <BillingIntervalToggle value={interval} onChange={setBillingInterval} />
      </div>

      <div
        className={cn(
          "grid grid-cols-1 gap-4 md:grid-cols-2",
          plans.length >= 4 ? "xl:grid-cols-4" : "xl:grid-cols-3",
        )}
      >
        {plans.map((plan) => {
          const isCurrent = currentPlan === plan.id;
          const yearlyView = interval === "year" && plan.price > 0;
          const maxAgents = plan.limits.maxAgents;

          return (
            <div
              key={plan.id}
              className={cn(
                "relative flex flex-col rounded-xl border p-5",
                isCurrent ? "border-brand" : "border-border",
              )}
            >
              {isCurrent && (
                <span className="bg-brand text-brand-foreground absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full px-2.5 py-0.5 text-[11px] font-semibold">
                  Current
                </span>
              )}

              {/* Header — fixed height so prices align across cards */}
              <div className="lg:min-h-[3.25rem]">
                <p className="text-foreground text-base font-semibold">
                  {plan.highlighted ? (
                    <span className="relative inline-block">
                      <span className="relative z-1">{plan.name}</span>
                      <span className="bg-brand/20 absolute bottom-0 left-0 h-3 w-full rounded-sm" />
                    </span>
                  ) : (
                    plan.name
                  )}
                  <span className="text-muted-foreground ml-1.5 text-sm font-normal">
                    ({plan.tagline})
                  </span>
                </p>
                <p className="text-muted-foreground text-xs">{plan.subtitle}</p>
              </div>

              {/* Pricing */}
              <div className="mt-3">
                <div className="flex items-baseline gap-1.5 lg:min-h-[2.5rem]">
                  {yearlyView && (
                    <span className="text-muted-foreground text-base font-medium line-through">
                      ${plan.price}
                    </span>
                  )}
                  <span className="text-foreground text-2xl font-bold">
                    $
                    {yearlyView
                      ? Math.round(plan.yearlyPrice / 12)
                      : plan.price}
                  </span>
                  <span className="text-muted-foreground text-xs">/month</span>
                </div>
                <p className="text-muted-foreground mt-1 text-xs">
                  {yearlyView
                    ? `Billed annually · $${plan.yearlyPrice.toLocaleString("en-US")}/yr · save $${(plan.price * 2).toLocaleString("en-US")}`
                    : plan.priceSub}
                </p>
              </div>

              {/* Agents included */}
              <div className="border-border mt-3 space-y-1 border-t pt-3">
                <div className="text-foreground flex items-center gap-2 text-sm font-medium">
                  <Link2 className="text-brand size-3.5 shrink-0" />
                  {maxAgents} agent{maxAgents !== 1 ? "s" : ""} included
                  <InfoTip tipKey="agent" />
                </div>
              </div>

              {/* Features */}
              <ul className="mt-1.5 flex-1 space-y-1.5">
                <li className="text-foreground flex items-start gap-2 text-sm font-medium">
                  <Check className="text-brand mt-0.5 size-3.5 shrink-0" />
                  <span className="flex items-center gap-1.5">
                    {Number.isFinite(plan.limits.maxMembers)
                      ? `${plan.limits.maxMembers} human seats`
                      : "Unlimited human seats"}
                    <span className="text-brand bg-brand/10 rounded-full px-1.5 py-0.5 text-[10px] font-semibold">
                      Included
                    </span>
                  </span>
                </li>
                {plan.features.map((feature) => (
                  <li
                    key={feature}
                    className="text-muted-foreground flex items-start gap-2 text-sm"
                  >
                    <Check className="text-brand mt-0.5 size-3.5 shrink-0" />
                    <span className="flex items-center">
                      {feature}
                      {feature === "Shared workspaces" ? (
                        <InfoTip tipKey="sharedWorkspaces" />
                      ) : (
                        /\bworkspaces?\b/i.test(feature) && (
                          <InfoTip tipKey="workspace" />
                        )
                      )}
                    </span>
                  </li>
                ))}
              </ul>

              {plan.id === "scale" && (
                <a
                  href="https://onecli.sh/contact?utm_source=dashboard-billing"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground mt-3 text-xs hover:underline"
                >
                  Need more than {plan.limits.maxMembers} seats? Talk to us
                </a>
              )}

              {/* Action button */}
              {(() => {
                const isLowerTier = planRank(plan.id) < planRank(currentPlan);

                if (isCurrent) {
                  if (isPaidPlan(plan.id)) {
                    if (cancelAtPeriodEnd) {
                      return (
                        <Button
                          variant="brand"
                          className="mt-5 w-full"
                          disabled={reactivating}
                          loading={reactivating}
                          onClick={reactivate}
                        >
                          Activate Plan
                        </Button>
                      );
                    }
                    if (
                      !salesManaged &&
                      currentInterval &&
                      interval !== currentInterval
                    ) {
                      return (
                        <Button
                          variant="brand"
                          className="mt-5 w-full"
                          disabled={portalLoading}
                          onClick={() => setSwitchTarget(plan)}
                        >
                          Switch to {interval === "year" ? "Yearly" : "Monthly"}{" "}
                          Billing
                        </Button>
                      );
                    }
                    return (
                      <Button
                        variant="outline"
                        className="mt-5 w-full"
                        disabled={portalLoading}
                        loading={portalLoading}
                        onClick={openPortal}
                      >
                        Manage Subscription
                      </Button>
                    );
                  }
                  return (
                    <div className="border-muted-foreground/40 text-muted-foreground mt-5 flex h-9 w-full items-center justify-center rounded-md border text-sm font-medium">
                      Current Plan
                    </div>
                  );
                }

                if (isLowerTier) {
                  return (
                    <div className="text-muted-foreground mt-5 flex h-9 w-full items-center justify-center text-sm">
                      Included in your plan
                    </div>
                  );
                }

                if (salesManaged) {
                  return (
                    <div className="text-muted-foreground mt-5 flex h-9 w-full items-center justify-center text-xs">
                      Contact sales to change your plan
                    </div>
                  );
                }

                const isRedirecting = loadingPlan === plan.id;

                return (
                  <Button
                    variant={plan.highlighted ? "brand" : "default"}
                    className="mt-5 w-full"
                    disabled={!!loadingPlan || portalLoading}
                    loading={isRedirecting}
                    onClick={() => handlePlanAction(plan)}
                  >
                    {isRedirecting
                      ? "Redirecting..."
                      : isPaidPlan(currentPlan)
                        ? "Switch Plan"
                        : "Upgrade"}
                    {!isRedirecting && <ArrowRight className="size-4" />}
                  </Button>
                );
              })()}
            </div>
          );
        })}
      </div>

      <div
        className={cn(
          "relative mt-4 rounded-xl border p-5",
          isSalesManagedPlan(currentPlan) ? "border-brand" : "border-border",
        )}
      >
        {isSalesManagedPlan(currentPlan) && (
          <span className="bg-brand text-brand-foreground absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full px-2.5 py-0.5 text-[11px] font-semibold">
            Current
          </span>
        )}
        <div className="flex items-start gap-4">
          <div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-lg">
            <Building2 className="text-muted-foreground size-5" />
          </div>
          <div className="flex-1">
            <p className="text-foreground text-base font-semibold">
              {ENTERPRISE_PLAN.name}
            </p>
            <p className="text-muted-foreground mt-0.5 text-sm">
              Custom integrations, dedicated support, SLA guarantees, SSO/SAML,
              and VPC/on-premise deployment options for teams with advanced
              requirements.
            </p>
            {(isSalesManagedPlan(currentPlan) || salesManaged) && (
              <p className="text-foreground mt-1 text-sm font-medium">
                Your plan is managed by our sales team.
              </p>
            )}
            <a
              href="https://onecli.sh/contact?utm_source=dashboard-billing"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground mt-2 inline-flex items-center gap-1.5 text-sm font-semibold hover:underline"
            >
              Contact Sales
              <ExternalLink className="size-3.5" />
            </a>
          </div>
        </div>
      </div>

      <PlanSwitchDialog
        plan={switchTarget}
        initialInterval={interval}
        onClose={() => setSwitchTarget(null)}
      />
    </>
  );
};
