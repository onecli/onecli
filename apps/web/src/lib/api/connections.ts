import { apiGet, apiPatch, apiPut, apiDelete } from "./client";
import type { PageScope } from "./scope";
import type { Connection, ConnectionAgentAccess } from "./types";

const connectionsPath = (scope: PageScope) =>
  scope === "organization" ? "/v1/org/connections" : "/v1/connections";

export const list = (scope: PageScope = "project") =>
  apiGet<Connection[]>(connectionsPath(scope));

export const rename = (
  id: string,
  label: string,
  scope: PageScope = "project",
) =>
  apiPatch<{ id: string; label: string }>(`${connectionsPath(scope)}/${id}`, {
    label,
  });

export const disconnect = (id: string, scope: PageScope = "project") =>
  apiDelete(`${connectionsPath(scope)}/${id}`);

// Reverse of agents.connections/updateConnections — the agents that can use a
// connection, keyed from the connection side. Project surface only (agents are
// project-scoped), so no scope switching.
export const agents = (connectionId: string) =>
  apiGet<ConnectionAgentAccess[]>(`/v1/connections/${connectionId}/agents`);

export const setAgents = (connectionId: string, agentIds: string[]) =>
  apiPut<{ success: boolean }>(`/v1/connections/${connectionId}/agents`, {
    agentIds,
  });
