import type { AdapterPresence } from "@onecli/agent-protocol";

/**
 * One of the agent's pages in the web app, `/w/<workspace>/agents/<agent>/
 * <section>`, for a button or link the adapter posts. Built only from server
 * config and the presence's own ids (never message text), each id
 * percent-encoded so none can add a path segment. The same shape the web's
 * navigation.ts builds (`agentPagePath`).
 */
export const agentPageUrl = (
  appUrl: string,
  agent: Pick<AdapterPresence["agent"], "id" | "workspaceId">,
  section: "chat" | "models",
): string =>
  `${appUrl}/w/${encodeURIComponent(agent.workspaceId)}/agents/${encodeURIComponent(agent.id)}/${section}`;
