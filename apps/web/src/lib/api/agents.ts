import { apiGet, apiPost, apiPut, apiPatch } from "./client";
import type {
  Agent,
  CreatedAgent,
  CreateAgentInput,
  AgentGranularAccess,
  AgentConnection,
} from "./types";

export const list = () => apiGet<Agent[]>("/v1/agents");

export const create = (input: CreateAgentInput) =>
  apiPost<CreatedAgent>("/v1/agents", input);

export const granularAccess = () =>
  apiGet<AgentGranularAccess[]>("/v1/agents/granular-access");

// ── Credential access (secret mode, secrets, app connections) ──────────────

export const secrets = (agentId: string) =>
  apiGet<string[]>(`/v1/agents/${agentId}/secrets`);

export const updateSecrets = (agentId: string, secretIds: string[]) =>
  apiPut<{ success: boolean }>(`/v1/agents/${agentId}/secrets`, { secretIds });

export const updateSecretMode = (agentId: string, mode: "all" | "selective") =>
  apiPatch<{ success: boolean }>(`/v1/agents/${agentId}/secret-mode`, { mode });

export const connections = (agentId: string) =>
  apiGet<AgentConnection[]>(`/v1/agents/${agentId}/connections`);

export const updateConnections = (
  agentId: string,
  connections: {
    appConnectionId: string;
    sessionPolicy?: Record<string, unknown> | null;
  }[],
) =>
  apiPut<{ success: boolean }>(`/v1/agents/${agentId}/connections`, {
    connections,
  });
