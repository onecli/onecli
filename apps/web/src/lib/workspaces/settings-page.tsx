import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db } from "@onecli/db";
import { getWorkspaceQuota } from "@onecli/api/ee/services/quota-service";
import { canManageWorkspace } from "@onecli/api/ee/services/authorization-service";
import { getServerSession } from "@/lib/auth/server";
import { PageHeader } from "@dashboard/page-header";
import { RenameWorkspaceForm } from "./_components/rename-workspace-form";
import { WorkspaceAccessCard } from "@/ee/workspaces/_components/workspace-access-card";
import { DeleteWorkspaceButton } from "./_components/delete-workspace-button";

export const metadata: Metadata = {
  title: "Workspace Settings",
};

interface Props {
  params: Promise<{ workspaceId: string }>;
}

export default async function WorkspaceSettingsPage({ params }: Props) {
  const { workspaceId } = await params;
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
      organizationId: true,
    },
  });
  if (!workspace) redirect("/org");
  // Manage-only pane (rename / share / delete). A member who can't manage is
  // sent to Install rather than out of the workspace: it is the other pane in
  // this section and the one they ARE entitled to.
  if (!(await canManageWorkspace(user.id, workspace.id))) {
    redirect(`/w/${workspace.id}/settings/install`);
  }

  // The delete guard is org-scoped ("can't delete the org's only workspace") to
  // match the DELETE /v1/workspaces/:id check and the workspaces-list guard — not
  // scoped to what this user created, so all three agree.
  const orgWorkspaceCount = await db.workspace.count({
    where: { organizationId: workspace.organizationId },
  });

  // The plan comes from the quota service, NOT raw subscriptionStatus: on
  // non-billing editions the service reports the top tier, keeping this page
  // in agreement with the workspaces list. Deriving "free" from the null
  // status here showed a licensed self-host a dead-end Stripe upgrade CTA
  // instead of Manage access (the license gate inside the card handles the
  // unlicensed arm).
  const { plan } = await getWorkspaceQuota(workspace.organizationId);

  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="General"
        description="Rename or delete this workspace. Billing and usage are in the sidebar under your organization."
      />
      <RenameWorkspaceForm
        workspaceId={workspace.id}
        currentName={workspace.name}
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
