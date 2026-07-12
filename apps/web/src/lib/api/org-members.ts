import { apiGet, apiPatch } from "./client";
import type {
  OrgMemberRow,
  UpdateOrgMemberInput,
  DirectoryPage,
  DirectoryListParams,
  OrgMemberListRow,
  GroupRow,
} from "./types";

// Member lifecycle (suspend/reinstate) + break-glass SSO exemption, plus the
// §3.5 directory reads (the members list feeds the group member picker; the
// team page's own list stays server-rendered).
const base = "/v1/org/members";

export const update = (userId: string, input: UpdateOrgMemberInput) =>
  apiPatch<OrgMemberRow>(`${base}/${userId}`, input);

export const list = (
  params: DirectoryListParams & { status?: "active" | "suspended" } = {},
) => {
  const search = new URLSearchParams();
  if (params.limit) search.set("limit", String(params.limit));
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.q) search.set("q", params.q);
  if (params.status) search.set("status", params.status);
  const qs = search.toString();
  return apiGet<DirectoryPage<OrgMemberListRow>>(
    `${base}${qs ? `?${qs}` : ""}`,
  );
};

/** Reverse lookup: the groups a member belongs to. */
export const groupsFor = (userId: string) =>
  apiGet<DirectoryPage<GroupRow>>(`${base}/${userId}/groups`);
