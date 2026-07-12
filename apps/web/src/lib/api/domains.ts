import { apiGet, apiPost, apiDelete } from "./client";
import type { OrgDomain } from "./types";

// Org email domains are organization-scoped only — no project variant.
const base = "/v1/org/domains";

export const list = () => apiGet<OrgDomain[]>(base);

export const create = (domain: string) => apiPost<OrgDomain>(base, { domain });

export const verify = (domainId: string) =>
  apiPost<OrgDomain>(`${base}/${domainId}/verify`, {});

export const remove = (domainId: string) => apiDelete(`${base}/${domainId}`);
