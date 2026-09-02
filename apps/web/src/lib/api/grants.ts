import { apiGet, apiPut, apiDelete } from "./client";
import type {
  AgentGrants,
  AgentWithGrantsSummary,
  ConnectionGrantInput,
  ConnectionGrants,
} from "./types";

// The attach-model grants API (workspace scope only — org policy stays rules).
// Mutations publish atomically server-side; the audited routes also flush the
// gateway cache, so callers never do either. Signatures are context-safe (no
// positional param a queryFn context object could fill).

export const forAgent = (agentId: string) =>
  apiGet<AgentGrants>(`/v1/agents/${agentId}/grants`);

export const setConnectionGrant = (
  agentId: string,
  connectionId: string,
  input: ConnectionGrantInput,
) =>
  apiPut<AgentGrants>(
    `/v1/agents/${agentId}/grants/connections/${connectionId}`,
    input,
  );

export const detachConnection = (agentId: string, connectionId: string) =>
  apiDelete(`/v1/agents/${agentId}/grants/connections/${connectionId}`);

export const attachSecret = (agentId: string, secretId: string) =>
  apiPut<AgentGrants>(`/v1/agents/${agentId}/grants/secrets/${secretId}`, {});

export const detachSecret = (agentId: string, secretId: string) =>
  apiDelete(`/v1/agents/${agentId}/grants/secrets/${secretId}`);

export const forConnection = (connectionId: string) =>
  apiGet<ConnectionGrants>(`/v1/connections/${connectionId}/grants`);

export const setForConnection = (
  connectionId: string,
  agentId: string,
  input: ConnectionGrantInput,
) =>
  apiPut<AgentGrants>(
    `/v1/connections/${connectionId}/grants/agents/${agentId}`,
    input,
  );

export const detachForConnection = (connectionId: string, agentId: string) =>
  apiDelete(`/v1/connections/${connectionId}/grants/agents/${agentId}`);

export const summary = () =>
  apiGet<AgentWithGrantsSummary[]>("/v1/agents?include=grants-summary");
