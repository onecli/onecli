import { apiGet } from "./client";
import type { DirectoryPage, DirectoryListParams, OrgAgentRow } from "./types";

// Org-wide agent read (§3.5 directory surface) — the agent-group member
// picker's data source; agents remain project-scoped resources elsewhere.
const base = "/v1/org/agents";

export const list = (params: DirectoryListParams = {}) => {
  const search = new URLSearchParams();
  if (params.limit) search.set("limit", String(params.limit));
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.q) search.set("q", params.q);
  const qs = search.toString();
  return apiGet<DirectoryPage<OrgAgentRow>>(`${base}${qs ? `?${qs}` : ""}`);
};
