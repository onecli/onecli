import { apiGet, apiPost, apiPatch, apiDelete } from "./client";
import { appsPath, type PageScope } from "./scope";

export interface AppConfigStatus {
  /** Absent in the no-config sentinel response. */
  settings?: Record<string, string>;
  hasCredentials: boolean;
  enabled: boolean;
  /**
   * `"organization"` when the workspace has no enabled config row of its own and
   * the status reports the org-level config instead (EE editions). There is no
   * workspace row behind it — nothing to edit, toggle, or delete at this scope.
   */
  source?: "organization";
  /**
   * Connections that removing or replacing this config would disconnect — the
   * blast radius shown in the org admin's confirm dialog. Present only on the
   * org config surface; workspace responses omit it. `orgConnections` are the
   * config's own org-scoped connections; `workspaceConnections` are the workspace
   * connections it minted across every workspace.
   */
  dependents?: { orgConnections: number; workspaceConnections: number };
}

export const get = (provider: string, scope: PageScope = "workspace") =>
  apiGet<AppConfigStatus>(appsPath(scope, `/${provider}/config`));

export const save = (
  provider: string,
  values: Record<string, string>,
  scope: PageScope = "workspace",
) => apiPost<{ success: true }>(appsPath(scope, `/${provider}/config`), values);

export const remove = (provider: string, scope: PageScope = "workspace") =>
  apiDelete(appsPath(scope, `/${provider}/config`));

export const toggle = (
  provider: string,
  enabled: boolean,
  scope: PageScope = "workspace",
) =>
  apiPatch<{ success: true }>(appsPath(scope, `/${provider}/config/toggle`), {
    enabled,
  });

export const configuredProviders = (scope: PageScope = "workspace") =>
  apiGet<string[]>(appsPath(scope, "/configured"));

export const envDefaults = () => apiGet<string[]>("/v1/apps/env-defaults");
