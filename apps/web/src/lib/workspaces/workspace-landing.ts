import { db } from "@onecli/db";
import { workspaceLandingPath } from "@/lib/agents/agent-order";
import { requireAccessibleWorkspace } from "@/lib/workspaces/workspace-access";

/**
 * The URL a bare `/w/<id>` forwards to: the workspace's OLDEST agent (the
 * sidebar's top row, same order as `sortAgentsOldestFirst`) on its first
 * section, or the create-agent page when the workspace has none.
 *
 * Access is proven HERE, not assumed from the layout: Next renders the layout
 * and the page concurrently, and this read names an agent id in the redirect
 * it returns, so an unauthorized caller must be turned away before it runs.
 */
export const resolveWorkspaceLanding = async (
  workspaceId: string,
): Promise<string> => {
  const workspace = await requireAccessibleWorkspace(workspaceId);
  const firstAgent = await db.agent.findFirst({
    where: { workspaceId: workspace.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, kind: true },
  });
  return workspaceLandingPath(workspace.id, firstAgent);
};
