import { apiGet, apiPost, apiPatch, apiDelete } from "./client";
import { appsPath, type PageScope } from "./scope";

export interface AppConfigStatus {
  /** Absent in the no-config sentinel response. */
  settings?: Record<string, string>;
  hasCredentials: boolean;
  enabled: boolean;
}

export const get = (provider: string, scope: PageScope = "project") =>
  apiGet<AppConfigStatus>(appsPath(scope, `/${provider}/config`));

export const save = (
  provider: string,
  values: Record<string, string>,
  scope: PageScope = "project",
) => apiPost<{ success: true }>(appsPath(scope, `/${provider}/config`), values);

export const remove = (provider: string, scope: PageScope = "project") =>
  apiDelete(appsPath(scope, `/${provider}/config`));

export const toggle = (
  provider: string,
  enabled: boolean,
  scope: PageScope = "project",
) =>
  apiPatch<{ success: true }>(appsPath(scope, `/${provider}/config/toggle`), {
    enabled,
  });

export const configuredProviders = (scope: PageScope = "project") =>
  apiGet<string[]>(appsPath(scope, "/configured"));

export const envDefaults = () => apiGet<string[]>("/v1/apps/env-defaults");
