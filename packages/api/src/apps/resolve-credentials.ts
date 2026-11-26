import { getAppConfigCredentials } from "../services/app-config-service";
import { getOrgAppConfig } from "../providers";
import { configKeysFor } from "./oauth/groups";
import type { AppDefinition } from "./types";
import type { ResourceScope } from "../services/resource-scope";

export interface ResolvedAppCredentials {
  values: Record<string, string>;
  source: "app_config" | "env";
  /**
   * Id of the AppConfig row that served these credentials (the workspace row or,
   * via the org seam, the org row). Absent for the env tier. Mint sites persist
   * it on the connection so refresh and config-removal know the provenance.
   */
  appConfigId?: string;
  /**
   * The AppConfig `provider` key that served these credentials: the app id
   * (legacy per-app row) or its vendor group ("google"). Absent for the env
   * tier. A group key means the client is shared across the vendor's apps, so
   * OAuth uses the vendor's single redirect URI (`redirectPathFor`).
   */
  configKey?: string;
}

/**
 * First complete stored config for `app` in one scope, most specific key
 * first: a legacy per-app row, then the app's vendor group row ("google").
 * Exported for the org resolver, which applies the same rule at org scope.
 */
export const resolveScopedAppConfig = async (
  scope: ResourceScope,
  app: AppDefinition,
): Promise<ResolvedAppCredentials | null> => {
  if (!app.configurable) return null;
  const requiredFields = app.configurable.fields.map((f) => f.name);

  for (const key of configKeysFor(app)) {
    const config = await getAppConfigCredentials(scope, key);
    if (config && requiredFields.every((f) => !!config.fields[f])) {
      const values: Record<string, string> = {};
      for (const f of requiredFields) values[f] = config.fields[f]!;
      return {
        values,
        source: "app_config",
        appConfigId: config.appConfigId,
        configKey: key,
      };
    }
  }
  return null;
};

/**
 * The platform (env) tier: every required field from its `envDefaults`
 * variable, or null when any is unset. Shared by the workspace and org
 * resolvers.
 */
export const resolveEnvAppCredentials = (
  app: AppDefinition,
): ResolvedAppCredentials | null => {
  if (!app.configurable) return null;
  const envDefaults = app.configurable.envDefaults ?? {};
  const values: Record<string, string> = {};
  for (const { name } of app.configurable.fields) {
    const envVar = envDefaults[name];
    const value = envVar ? process.env[envVar] : undefined;
    if (!value) return null;
    values[name] = value;
  }
  return { values, source: "env" };
};

/**
 * Generic credential resolution for any configurable app.
 * Uses the app's `configurable.fields` to determine which keys are needed,
 * then resolves them from the workspace's AppConfig → the organization's
 * AppConfig (EE editions with the `orgAppConfig` seam registered; skipped in
 * OSS) → env vars (platform defaults) → null. Within each scope a legacy
 * per-app row beats the vendor group row, so a workspace's Google client
 * overrides the org's Google client for every Google app in that workspace.
 *
 * Works for all method types: OAuth (clientId/clientSecret), GitHub App (appId/appSlug/privateKey),
 * and any future configurable provider.
 */
export const resolveAppCredentials = async (
  workspaceId: string,
  app: AppDefinition,
  organizationId?: string,
): Promise<ResolvedAppCredentials | null> => {
  if (!app.configurable) return null;

  const workspace = await resolveScopedAppConfig({ workspaceId }, app);
  if (workspace) return workspace;

  const orgAppConfig = getOrgAppConfig();
  if (orgAppConfig && organizationId) {
    const resolved = await orgAppConfig.resolveCredentials(organizationId, app);
    if (resolved) return resolved;
  }

  return resolveEnvAppCredentials(app);
};
