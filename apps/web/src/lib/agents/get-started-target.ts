import type { AgentKind } from "@/lib/api/types";
import { agentChatPath, agentsCreatePath } from "@/lib/navigation";

/**
 * The only fields this decision needs. Structural on purpose: the URL-scoped
 * list and the explicit-workspace list both qualify, and ISO timestamps order
 * correctly as strings, which is all a min-by needs.
 */
export interface GetStartedAgent {
  id: string;
  name: string;
  kind: AgentKind;
  createdAt: string;
}

/**
 * The agent the primary button points at: the OLDEST hosted one, so the target
 * doesn't move as more are added.
 *
 * Only hosted agents count — a BYO agent is a token for a laptop, with no
 * thread to open — so a workspace holding only those still gets the create
 * door.
 */
export const firstHostedAgent = <T extends GetStartedAgent>(
  agents: T[],
): T | undefined =>
  agents
    .filter((agent) => agent.kind === "hosted")
    .reduce<
      T | undefined
    >((oldest, agent) => (!oldest || agent.createdAt < oldest.createdAt ? agent : oldest), undefined);

/**
 * Where the primary button lands. The answer changes exactly once: before the
 * first hosted agent exists, getting started means CREATING one; after that it
 * means talking to it (§3.18 — the agent is the thread).
 */
export const getStartedPath = (
  workspaceId: string,
  agents: GetStartedAgent[],
): string => {
  const agent = firstHostedAgent(agents);
  return agent
    ? agentChatPath(workspaceId, agent.id)
    : agentsCreatePath(workspaceId);
};
