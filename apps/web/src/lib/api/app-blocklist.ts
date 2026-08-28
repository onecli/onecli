import { apiGet, apiPost, apiPatch, apiDelete } from "./client";
import { appsPath, type PageScope } from "./scope";

export type { PageScope } from "./scope";

export interface BlocklistHostState {
  hostId: string;
  ruleId: string | null;
  enabled: boolean;
  /** Always false since step 10 — arbitrary hosts are blocked with a policy
   * rule, so every entry here is one the app itself declares. Kept so existing
   * clients keep parsing. */
  custom: boolean;
  name: string;
  hostPattern: string;
  scope: "organization" | "workspace" | null;
}

const basePath = (provider: string, scope: PageScope) =>
  appsPath(scope, `/${provider}/blocklist`);

export const list = (provider: string, scope: PageScope = "workspace") =>
  apiGet<BlocklistHostState[]>(basePath(provider, scope));

export const activateHost = (
  provider: string,
  hostId: string,
  scope: PageScope = "workspace",
) => apiPost<BlocklistHostState>(basePath(provider, scope), { hostId });

export const toggle = (
  provider: string,
  ruleId: string,
  enabled: boolean,
  scope: PageScope = "workspace",
) =>
  apiPatch<{ success: true }>(`${basePath(provider, scope)}/${ruleId}`, {
    enabled,
  });

export const remove = (
  provider: string,
  ruleId: string,
  scope: PageScope = "workspace",
) => apiDelete(`${basePath(provider, scope)}/${ruleId}`);
