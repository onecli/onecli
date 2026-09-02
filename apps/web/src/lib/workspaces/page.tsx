import type { Metadata } from "next";
import { normalizePlan } from "@onecli/api/ee/billing/plans";
import { PageHeader } from "@dashboard/page-header";
import { getWorkspaces, getWorkspaceQuotaAction } from "./actions";
import { CreateWorkspaceButton } from "./_components/create-workspace-button";
import { EmptyWorkspaces } from "./_components/empty-workspaces";
import { WorkspaceCard } from "./_components/workspace-card";

export const metadata: Metadata = {
  title: "Workspaces",
};

export default async function OrgWorkspacesPage() {
  const [workspaces, quota] = await Promise.all([
    getWorkspaces(),
    getWorkspaceQuotaAction(),
  ]);

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title="Workspaces"
          description="Each workspace has its own agents, secrets, connections, and rules."
        />
        {workspaces.length > 0 && <CreateWorkspaceButton quota={quota} />}
      </div>
      {workspaces.length === 0 ? (
        <EmptyWorkspaces quota={quota} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {workspaces.map((workspace) => (
            <WorkspaceCard
              key={workspace.id}
              id={workspace.id}
              name={workspace.name}
              agentCount={workspace.agentCount}
              resourceCount={workspace.resourceCount}
              owner={workspace.owner}
              canManage={workspace.canManage}
              isLastWorkspace={quota.workspaceCount <= 1}
              organizationId={quota.organizationId}
              plan={normalizePlan(quota.plan)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
