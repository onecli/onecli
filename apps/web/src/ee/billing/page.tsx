"use client";

import { useSubscriptionStatus } from "@/ee/billing/use-subscription-status";
import { BillingContent } from "@/ee/billing/billing-content";
import { PageHeader } from "@dashboard/page-header";

export default function BillingPage() {
  const subscription = useSubscriptionStatus();

  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Billing"
        description="Manage your subscription and billing."
        character="drop-list"
      />

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
