import { redirect } from "next/navigation";
import { getApiRequests, getPlanUsage } from "@/ee/billing/api-request-actions";
import { getSubscriptionStatus } from "@/ee/billing/actions";
import { ApiRequestsContent } from "@/ee/billing/_components/api-requests-content";
import { PlanUsageContent } from "@/ee/billing/_components/plan-usage-content";
import { CurrentPlanCard } from "@/ee/billing/_components/current-plan-card";
import { CAPS } from "@/lib/env";
import { resolveOrgContext } from "@/lib/actions/resolve-user";
import { requireOrgAdmin } from "@/ee/auth/require-org-admin";

export default async function ApiRequestsPage() {
  const { organizationId } = await resolveOrgContext();

  // Usage/quota tracking is a billing surface: editions without billing hide
  // it from nav and shouldn't serve the route either — send direct navigations
  // to the org's workspaces.
  if (!CAPS.billing) redirect(`/org/${organizationId}/workspaces`);

  // Defense-in-depth alongside the (admin) route-group guard — usage reads are
  // member-readable at the data layer, so the page guards itself too.
  await requireOrgAdmin();
  const [data, usage, subscription] = await Promise.all([
    getApiRequests(),
    getPlanUsage(),
    getSubscriptionStatus(),
  ]);

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Usage</h1>
        <p className="text-muted-foreground text-sm">
          Track your plan usage and API requests.
        </p>
      </div>

      <CurrentPlanCard subscription={subscription} />
      <PlanUsageContent data={usage} />
      <ApiRequestsContent data={data} />
    </div>
  );
}
