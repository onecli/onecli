import { redirect } from "next/navigation";
import { PageHeader } from "@dashboard/page-header";
import { isEntitled } from "@onecli/api/lib/entitlements";
import { resolveOrgContext } from "@/lib/actions/resolve-user";
import { requireOrgAdmin } from "@/ee/auth/require-org-admin";
import { AppAvailabilityEditor } from "./_components/app-availability-editor";

export default async function AppAvailabilityPage() {
  const { organizationId } = await resolveOrgContext();

  // The app availability allowlist is licensed: the route wrapper renders the
  // licensed card, so this only fires if the page is ever mounted without it —
  // the licensed surface stays dark on its own. Read at runtime: the client
  // bundle's CAPS can never see ENTERPRISE_ENABLED, so an entitled self-host
  // reads as rbac-less there and gating on it bounced paying admins.
  if (!isEntitled()) redirect(`/org/${organizationId}/workspaces`);

  // Kept alongside the (admin) route-group guard as defense-in-depth; fails
  // closed (any role-check error redirects rather than rendering admin UI).
  await requireOrgAdmin();

  return (
    <div className="flex flex-1 flex-col gap-8">
      <PageHeader
        title="App Availability"
        description="Choose which apps each workspace may connect, based on who has access to it."
      />
      <AppAvailabilityEditor />
    </div>
  );
}
