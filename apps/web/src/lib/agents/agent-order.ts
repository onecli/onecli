import { defaultAgentSection } from "@/lib/agents/agent-sections";

/**
 * The workspace's agent order for navigation: OLDEST first. One rule for
 * every place that must agree on "the first agent": the sidebar's agent list
 * (top row), the header's agent switcher, the `/agents` door, and the
 * workspace landing (`/w/<id>` opens that top row). The API list stays
 * newest-first for its other readers (the CLI, the SDK).
 */
export const sortAgentsOldestFirst = <
  T extends { id: string; createdAt: string | Date },
>(
  agents: readonly T[],
): T[] =>
  [...agents].sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
      // Same-instant ties break on id, so the order is total and stable.
      a.id.localeCompare(b.id),
  );

/**
 * Where a bare workspace URL lands: the first agent's first section (Chat for
 * hosted, Connections for BYO), or the agents page when there is none yet
 * — its empty state is where the first agent gets created.
 */
export const workspaceLandingPath = (
  workspaceId: string,
  firstAgent: { id: string; kind: string } | null,
): string => {
  const ws = `/w/${encodeURIComponent(workspaceId)}`;
  if (!firstAgent) return `${ws}/agents`;
  return `${ws}/agents/${encodeURIComponent(firstAgent.id)}/${defaultAgentSection(firstAgent.kind)}`;
};
