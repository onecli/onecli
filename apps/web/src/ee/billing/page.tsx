"use client";

import { useSubscriptionStatus } from "@/ee/billing/use-subscription-status";
import { BillingContent } from "@/ee/billing/billing-content";

export default function BillingPage() {
  const subscription = useSubscriptionStatus();

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-muted-foreground text-sm">
          Manage your subscription and billing.
        </p>
      </div>

      {subscription === null ? (
        <div className="flex items-center justify-center py-12">
          <div className="text-brand h-8 w-8 animate-spin rounded-full border-2 border-current border-t-transparent" />
        </div>
      ) : (
        <BillingContent
          status={subscription.status}
          cancelAtPeriodEnd={subscription.cancelAtPeriodEnd}
          currentInterval={subscription.interval}
          salesManaged={subscription.salesManaged}
        />
      )}
    </div>
  );
}
