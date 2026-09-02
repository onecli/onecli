import { CreditCard } from "lucide-react";
import {
  getPlanConfig,
  isPaidPlan,
  normalizePlan,
} from "@onecli/api/ee/billing/plans";
import type { SubscriptionState } from "@/ee/billing/actions";

export interface CurrentPlanCardProps {
  subscription: SubscriptionState;
}

/** Flat what-you-pay summary for the usage page — no metering, no estimates. */
export const CurrentPlanCard = ({ subscription }: CurrentPlanCardProps) => {
  const plan = getPlanConfig(normalizePlan(subscription.status));

  const priceLabel = !isPaidPlan(plan.id)
    ? "Free"
    : plan.price === 0 || subscription.salesManaged
      ? "Custom pricing"
      : subscription.interval === "year"
        ? `$${plan.yearlyPrice.toLocaleString("en-US")}/yr`
        : `$${plan.price}/mo`;

  return (
    <div className="border-border flex items-center gap-4 rounded-xl border p-5">
      <div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-lg">
        <CreditCard className="text-muted-foreground size-5" />
      </div>
      <div className="flex-1">
        <p className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
          Current plan
        </p>
        <p className="text-foreground text-base font-semibold">
          {plan.name}
          <span className="text-muted-foreground ml-2 text-sm font-normal">
            {priceLabel}
          </span>
        </p>
      </div>
      {subscription.renewsAt && (
        <p className="text-muted-foreground text-xs">
          {subscription.cancelAtPeriodEnd ? "Ends" : "Renews"}{" "}
          {new Date(subscription.renewsAt).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
          })}
        </p>
      )}
    </div>
  );
};
