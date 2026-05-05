import { getAppConfigCredentials } from "@/lib/services/app-config-service";
import type { AppDefinition } from "./types";

export interface ResolvedAppCredentials {
  values: Record<string, string>;
  source: "app_config" | "env";
}

/**
 * Generic credential resolution for any configurable app.
 * Uses the app's `configurable.fields` to determine which keys are needed,
 * then resolves them from AppConfig (user-provided) → env vars (platform defaults) → null.
 *
 * Works for all method types: OAuth (clientId/clientSecret), GitHub App (appId/appSlug/privateKey),
 * and any future configurable provider.
 */
export const resolveAppCredentials = async (
  projectId: string,
  app: AppDefinition,
): Promise<ResolvedAppCredentials | null> => {
  if (!app.configurable) return null;

  const requiredFields = app.configurable.fields.map((f) => f.name);

  const config = await getAppConfigCredentials(projectId, app.id);
  if (config && requiredFields.every((f) => !!config[f])) {
    const values: Record<string, string> = {};
    for (const f of requiredFields) values[f] = config[f]!;
    return { values, source: "app_config" };
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
