import { redirect } from "next/navigation";
import { db } from "@onecli/db";
import { getWorkspaceQuota } from "@onecli/api/ee/services/quota-service";
import { canManageWorkspace } from "@onecli/api/ee/services/authorization-service";
import { getServerSession } from "@/lib/auth/server";
import { PageHeader } from "@dashboard/page-header";
import { RenameWorkspaceForm } from "./_components/rename-workspace-form";
import { WorkspaceTimezoneCard } from "./_components/workspace-timezone-card";
import { WorkspaceAccessCard } from "@/ee/workspaces/_components/workspace-access-card";
import { DeleteWorkspaceButton } from "./_components/delete-workspace-button";

/** Settings > Workspace > Settings: rename, timezone, access, delete. */
export default async function WorkspaceSettingsPage({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const session = await getServerSession();
  if (!session) redirect("/auth/login");

  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: { id: true },
  });
  if (!user) redirect("/auth/login");

  // Settings is a MANAGE surface (rename / share / delete). Fetch the workspace
  // within the user's active org membership for its display fields, then gate on
  // management authority — an owner-role binding OR org admin/owner (step 13c).
  // (Previously scoped to createdByUserId, which also wrongly excluded org admins.)
  const workspace = await db.workspace.findFirst({
    where: {
      id: workspaceId,
      organization: {
        members: { some: { userId: user.id, status: { not: "suspended" } } },
      },
    },
    select: {
      id: true,
      name: true,
      timezone: true,
      organizationId: true,
    },
  });
  if (!workspace) redirect("/org");

  // Three independent reads, run together. The delete guard is org-scoped
  // ("can't delete the org's only workspace") to match the DELETE
  // /v1/workspaces/:id check and the workspaces-list guard, not scoped to
  // what this user created, so all three agree. The plan comes from the
  // quota service, NOT raw subscriptionStatus: on non-billing editions the
  // service reports the top tier, keeping this page in agreement with the
  // workspaces list. Deriving "free" from the null status here showed a
  // licensed self-host a dead-end Stripe upgrade CTA instead of Manage
  // access (the license gate inside the card handles the unlicensed arm).
  const [canManage, orgWorkspaceCount, { plan }] = await Promise.all([
    canManageWorkspace(user.id, workspace.id),
    db.workspace.count({ where: { organizationId: workspace.organizationId } }),
    getWorkspaceQuota(workspace.organizationId),
  ]);
  // Manage-only (rename / share / delete). The modal never offers the page
  // to a viewer who can't manage the workspace (`visibleSettingsPages`);
  // this is the backstop, and it renders nothing.
  if (!canManage) return null;

  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        character="drop-list"
        title="Settings"
        description="Rename this workspace, set the timezone its agents run in, or delete it."
      />
      <RenameWorkspaceForm
        workspaceId={workspace.id}
        currentName={workspace.name}
      />
      <WorkspaceTimezoneCard
        workspaceId={workspace.id}
        currentTimezone={workspace.timezone}
      />
      <WorkspaceAccessCard workspaceId={workspace.id} plan={plan} />
      <DeleteWorkspaceButton
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        organizationId={workspace.organizationId}
        isLastWorkspace={orgWorkspaceCount <= 1}
      />
    </div>
  );
}
