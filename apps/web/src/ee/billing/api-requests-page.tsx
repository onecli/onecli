import { redirect } from "next/navigation";
import { getApiRequests, getPlanUsage } from "@/ee/billing/api-request-actions";
import { getSubscriptionStatus } from "@/ee/billing/actions";
import { ApiRequestsContent } from "@/ee/billing/_components/api-requests-content";
import { RuntimeUsageContent } from "@/lib/usage/_components/runtime-usage-content";
import { PlanUsageContent } from "@/ee/billing/_components/plan-usage-content";
import { CurrentPlanCard } from "@/ee/billing/_components/current-plan-card";
import { CAPS } from "@/lib/env";
import { resolveOrgContext } from "@/lib/actions/resolve-user";
import { orgHomePath } from "@/lib/navigation";
import { requireOrgAdmin } from "@/ee/auth/require-org-admin";
import { PageHeader } from "@dashboard/page-header";

export default async function ApiRequestsPage() {
  const { organizationId } = await resolveOrgContext();

  // Usage/quota tracking is a billing surface: editions without billing hide
  // it from nav and shouldn't serve the route either — send direct navigations
  // to the org's workspaces.
  if (!CAPS.billing) redirect(orgHomePath(organizationId));

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
      <PageHeader
        title="Usage"
        description="Track your plan usage and API requests."
        character="drop-think"
      />

      <CurrentPlanCard subscription={subscription} />
      <PlanUsageContent data={usage} />
      <ApiRequestsContent data={data} />
      <RuntimeUsageContent
        periodStart={data.periodStart.slice(0, 10)}
        agentNames={Object.fromEntries(
          data.perAgent.map((a) => [a.agentId, a.agentName]),
        )}
      />
    </div>
  );
}
