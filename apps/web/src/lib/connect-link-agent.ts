import { safeDecode } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/safe-decode";

/**
 * The agent a connections-page link names: `?source=agent&agent_name=&agent_id=`.
 * Minted by the gateway's connect link, and by an agent's connect doors when
 * an app needs its credentials set up on its connections page first. One
 * reader and one writer, so every page that hands a connect on keeps the
 * agent the same way.
 */
export interface ConnectLinkAgent {
  /** Shown in the dialog and popup ("<agent> is requesting access"). */
  name: string;
  /** Switches the new account on for this agent (fenced by the API). Absent
   * on a link minted before the gateway carried it. */
  id?: string;
}

/** Read the link's agent; undefined unless the link says it came from one. */
export const readConnectLinkAgent = (
  params: Pick<URLSearchParams, "get">,
): ConnectLinkAgent | undefined =>
  params.get("source") === "agent"
    ? {
        name: safeDecode(params.get("agent_name")) ?? "your agent",
        id: params.get("agent_id") || undefined,
      }
    : undefined;

/** A connections-page path that hands a connect on to `agentId`: the page
 * shows the workspace's own name for it (`useVerifiedConnectLinkAgent`), so
 * the id is all a door has to send. */
export const withConnectLinkAgent = (path: string, agentId: string): string =>
  agentId
    ? `${path}?${new URLSearchParams({ source: "agent", agent_id: agentId })}`
    : path;
