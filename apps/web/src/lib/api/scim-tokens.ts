import { apiGet, apiPost, apiDelete } from "./client";
import type { ScimToken, CreatedScimToken } from "./types";

// SCIM provisioning tokens are organization-scoped only — no project variant.
const base = "/v1/org/scim/tokens";

export const list = () => apiGet<ScimToken[]>(base);

export const create = (label: string) =>
  apiPost<CreatedScimToken>(base, { label });

export const revoke = (tokenId: string) => apiDelete(`${base}/${tokenId}`);
