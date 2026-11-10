import { PlainPageHeaders } from "@dashboard/page-header";
import { CAPS } from "@/lib/env";
import BillingRoute from "@/ee/billing/billing-route";
import ApiRequestsPage from "@/ee/billing/api-requests-page";

/** Settings > Billing & usage: the plan, then this month's usage. Both
 *  route pages guard the billing capability themselves; this one only
 *  picks the order. */
export const BillingBody = () => {
  if (!CAPS.billing) return null;
  return (
    <div className="flex flex-1 flex-col gap-10">
      <BillingRoute />
      <PlainPageHeaders>
        <ApiRequestsPage />
      </PlainPageHeaders>
    </div>
  );
};
