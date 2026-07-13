import { apiGet, apiPost, apiPatch, apiPut, apiDelete } from "./client";
import type {
  DirectoryPage,
  DirectoryListParams,
  AgentGroupRow,
  AgentGroupMemberRow,
} from "./types";

// Org directory: agent groups — the machine mirror of groups.ts (§3.5).
const base = "/v1/org/agent-groups";

const query = (params: DirectoryListParams = {}) => {
  const search = new URLSearchParams();
  if (params.limit) search.set("limit", String(params.limit));
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.q) search.set("q", params.q);
  const qs = search.toString();
  return qs ? `?${qs}` : "";
};

export const list = (params?: DirectoryListParams) =>
  apiGet<DirectoryPage<AgentGroupRow>>(`${base}${query(params)}`);

export const create = (name: string) => apiPost<AgentGroupRow>(base, { name });

export const rename = (groupId: string, name: string) =>
  apiPatch<AgentGroupRow>(`${base}/${groupId}`, { name });

export const remove = (groupId: string) => apiDelete(`${base}/${groupId}`);

export const members = (groupId: string, params?: DirectoryListParams) =>
  apiGet<DirectoryPage<AgentGroupMemberRow>>(
    `${base}/${groupId}/members${query(params)}`,
  );

/** Bulk replace-set — the members dialog's save. */
export const setMembers = (groupId: string, agentIds: string[]) =>
  apiPut<{ added: number; removed: number }>(`${base}/${groupId}/members`, {
    agentIds,
  });

/** Incremental, idempotent single-member ops (the scripting surface). */
export const addMember = (groupId: string, agentId: string) =>
  apiPut<void>(`${base}/${groupId}/members/${agentId}`, {});

export const removeMember = (groupId: string, agentId: string) =>
  apiDelete(`${base}/${groupId}/members/${agentId}`);

/** Reverse lookup: the agent groups an agent belongs to. */
export const groupsForAgent = (agentId: string) =>
  apiGet<DirectoryPage<AgentGroupRow>>(`/v1/agents/${agentId}/groups`);
