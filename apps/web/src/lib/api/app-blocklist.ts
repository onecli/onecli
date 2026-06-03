import { apiGet, apiPost, apiPatch, apiDelete } from "./client";

export type PageScope = "project" | "organization";

export interface BlocklistHostState {
  hostId: string;
  ruleId: string | null;
  enabled: boolean;
  custom: boolean;
  name: string;
  hostPattern: string;
  scope: "organization" | "project" | null;
}

const basePath = (provider: string, scope: PageScope) =>
  scope === "organization"
    ? `/v1/org/apps/${provider}/blocklist`
    : `/v1/apps/${provider}/blocklist`;

export const list = (provider: string, scope: PageScope = "project") =>
  apiGet<BlocklistHostState[]>(basePath(provider, scope));

export const activateHost = (
  provider: string,
  hostId: string,
  scope: PageScope = "project",
) => apiPost<BlocklistHostState>(basePath(provider, scope), { hostId });

export const addCustom = (
  provider: string,
  name: string,
  hostPattern: string,
  scope: PageScope = "project",
) =>
  apiPost<BlocklistHostState>(basePath(provider, scope), {
    name,
    hostPattern,
  });

export const toggle = (
  provider: string,
  ruleId: string,
  enabled: boolean,
  scope: PageScope = "project",
) =>
  apiPatch<{ success: true }>(`${basePath(provider, scope)}/${ruleId}`, {
    enabled,
  });

export const remove = (
  provider: string,
  ruleId: string,
  scope: PageScope = "project",
) => apiDelete(`${basePath(provider, scope)}/${ruleId}`);
