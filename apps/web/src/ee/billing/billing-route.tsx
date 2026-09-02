import { redirect } from "next/navigation";
import { CAPS } from "@/lib/env";
import { resolveOrgContext } from "@/lib/actions/resolve-user";
import { requireOrgAdmin } from "@/ee/auth/require-org-admin";
import BillingPage from "@/ee/billing/page";

export default async function BillingRoute() {
  const { organizationId } = await resolveOrgContext();

  // Billing is a paid-plan surface: editions without billing hide it from nav
  // and shouldn't serve the route either — send direct navigations to the
  // org's workspaces.
  if (!CAPS.billing) redirect(`/org/${organizationId}/workspaces`);

  // Kept alongside the (admin) route-group guard as defense-in-depth: billing's
  // underlying reads are member-readable at the data layer, so this is the
  // page's own admin enforcement rather than relying solely on the layout.
  await requireOrgAdmin();
  return <BillingPage />;
}
