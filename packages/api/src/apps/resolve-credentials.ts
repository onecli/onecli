import { getAppConfigCredentials } from "../services/app-config-service";
import { getOrgAppConfig } from "../providers";
import type { AppDefinition } from "./types";

export interface ResolvedAppCredentials {
  values: Record<string, string>;
  source: "app_config" | "env";
  /**
   * Id of the AppConfig row that served these credentials (the project row or,
   * via the org seam, the org row). Absent for the env tier. Mint sites persist
   * it on the connection so refresh and config-removal know the provenance.
   */
  appConfigId?: string;
}

/**
 * Generic credential resolution for any configurable app.
 * Uses the app's `configurable.fields` to determine which keys are needed,
 * then resolves them from AppConfig (user-provided) → the organization's
 * AppConfig (EE editions with the `orgAppConfig` seam registered; skipped in
 * OSS) → env vars (platform defaults) → null.
 *
 * Works for all method types: OAuth (clientId/clientSecret), GitHub App (appId/appSlug/privateKey),
 * and any future configurable provider.
 */
export const resolveAppCredentials = async (
  projectId: string,
  app: AppDefinition,
  organizationId?: string,
): Promise<ResolvedAppCredentials | null> => {
  if (!app.configurable) return null;

  const requiredFields = app.configurable.fields.map((f) => f.name);

  const config = await getAppConfigCredentials({ projectId }, app.id);
  if (config && requiredFields.every((f) => !!config.fields[f])) {
    const values: Record<string, string> = {};
    for (const f of requiredFields) values[f] = config.fields[f]!;
    return { values, source: "app_config", appConfigId: config.appConfigId };
  }

  const orgAppConfig = getOrgAppConfig();
  if (orgAppConfig && organizationId) {
    const resolved = await orgAppConfig.resolveCredentials(organizationId, app);
    if (resolved) return resolved;
  }

  const envDefaults = app.configurable.envDefaults ?? {};
  const values: Record<string, string> = {};
  for (const field of requiredFields) {
    const envVar = envDefaults[field];
    if (!envVar) return null;
    const value = process.env[envVar];
    if (!value) return null;
    values[field] = value;
  }

  return { values, source: "env" };
};
