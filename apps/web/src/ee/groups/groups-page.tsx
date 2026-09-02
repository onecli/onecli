import { redirect } from "next/navigation";
import { PageHeader } from "@dashboard/page-header";
import { isEntitled } from "@onecli/api/lib/entitlements";
import { resolveOrgContext } from "@/lib/actions/resolve-user";
import { requireOrgAdmin } from "@/ee/auth/require-org-admin";
import { GroupList } from "./_components/group-list";
import { RoleMappingList } from "./_components/role-mapping-list";

export default async function GroupsPage() {
  const { organizationId } = await resolveOrgContext();

  // Directory management is licensed: the route wrapper renders the licensed
  // card, so this only fires if the page is ever mounted without it — the
  // licensed surface stays dark on its own. Read at runtime: the client
  // bundle's CAPS can never see ENTERPRISE_ENABLED, so an entitled self-host
  // reads as rbac-less there and gating on it bounced paying admins.
  if (!isEntitled()) redirect(`/org/${organizationId}/workspaces`);

  // Kept alongside the (admin) route-group guard as defense-in-depth; fails
  // closed (any role-check error redirects rather than rendering admin UI).
  await requireOrgAdmin();

  return (
    <div className="flex flex-1 flex-col gap-8">
      <PageHeader
        title="Groups"
        description="Organize members into groups, the building blocks for group-level access."
      />
      <GroupList />
      <RoleMappingList />
    </div>
  );
}
