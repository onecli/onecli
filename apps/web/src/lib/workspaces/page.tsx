import type { Metadata } from "next";
import { normalizePlan } from "@onecli/api/ee/billing/plans";
import { PageHeader } from "@dashboard/page-header";
import { getWorkspaces, getWorkspaceQuotaAction } from "./actions";
import { CreateWorkspaceButton } from "./_components/create-workspace-button";
import { EmptyWorkspaces } from "./_components/empty-workspaces";
import { WorkspaceRow } from "./_components/workspace-row";

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
      <PageHeader
        title="Workspaces"
        character="cloud"
        description="Each workspace has its own agents, secrets, connections, and rules."
        action={
          workspaces.length > 0 && <CreateWorkspaceButton quota={quota} />
        }
      />
      {workspaces.length === 0 ? (
        <EmptyWorkspaces quota={quota} />
      ) : (
        // One box of quiet rows: each workspace's facts on a single line
        // under its name.
        <section className="bg-card divide-y overflow-hidden rounded-lg border">
          {workspaces.map((workspace) => (
            <WorkspaceRow
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
        </section>
      )}
    </div>
  );
}
