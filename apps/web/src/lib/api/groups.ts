import { apiGet, apiPost, apiPatch, apiPut, apiDelete } from "./client";
import type {
  DirectoryPage,
  DirectoryListParams,
  GroupRow,
  GroupMemberRow,
} from "./types";

// Org directory: human groups (§3.5 contract) — organization-scoped only.
const base = "/v1/org/groups";

const query = (params: DirectoryListParams & { source?: string } = {}) => {
  const search = new URLSearchParams();
  if (params.limit) search.set("limit", String(params.limit));
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.q) search.set("q", params.q);
  if (params.source) search.set("source", params.source);
  const qs = search.toString();
  return qs ? `?${qs}` : "";
};

export const list = (params?: DirectoryListParams & { source?: string }) =>
  apiGet<DirectoryPage<GroupRow>>(`${base}${query(params)}`);

export const create = (name: string) => apiPost<GroupRow>(base, { name });

export const rename = (groupId: string, name: string) =>
  apiPatch<GroupRow>(`${base}/${groupId}`, { name });

export const remove = (groupId: string) => apiDelete(`${base}/${groupId}`);

export const members = (groupId: string, params?: DirectoryListParams) =>
  apiGet<DirectoryPage<GroupMemberRow>>(
    `${base}/${groupId}/members${query(params)}`,
  );

/** Bulk replace-set — the members dialog's save. */
export const setMembers = (groupId: string, userIds: string[]) =>
  apiPut<{ added: number; removed: number }>(`${base}/${groupId}/members`, {
    userIds,
  });

/** Incremental, idempotent single-member ops (the scripting surface). */
export const addMember = (groupId: string, userId: string) =>
  apiPut<void>(`${base}/${groupId}/members/${userId}`, {});

export const removeMember = (groupId: string, userId: string) =>
  apiDelete(`${base}/${groupId}/members/${userId}`);
