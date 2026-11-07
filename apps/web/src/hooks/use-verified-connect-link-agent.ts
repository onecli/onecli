import { useAgents } from "@/hooks/use-agents";
import type { ConnectLinkAgent } from "@/lib/connect-link-agent";

/** The name shown while the workspace's agents are still loading. */
const PENDING_NAME = "your agent";

/**
 * The link's agent as the page should SHOW it: when the link carries an id,
 * the name is the workspace's own record for that id, never the link's
 * `agent_name` (a hand-edited link could otherwise say one agent is asking
 * while the connect turns the account on for another).
 *  - While the agents load, the id is kept (the API fences it to the
 *    workspace before any grant) under a neutral name, so an early click
 *    still connects for the agent.
 *  - An id the workspace doesn't have names no agent at all.
 *  - A legacy link with a name and no id keeps its name: it turns nothing on.
 */
export const useVerifiedConnectLinkAgent = (
  agent: ConnectLinkAgent | undefined,
): ConnectLinkAgent | undefined => {
  const { data: agents } = useAgents(Boolean(agent?.id));
  if (!agent?.id) return agent;
  if (!agents) return { id: agent.id, name: PENDING_NAME };
  const own = agents.find((a) => a.id === agent.id);
  return own ? { id: own.id, name: own.name } : undefined;
};
