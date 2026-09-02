import { getAppConfigCredentials } from "../services/app-config-service";
import type { AppDefinition } from "./types";
import type { ResolvedAppCredentials } from "./resolve-credentials";

export const resolveOrgAppCredentials = async (
  organizationId: string,
  app: AppDefinition,
): Promise<ResolvedAppCredentials | null> => {
  if (!app.configurable) return null;

  const requiredFields = app.configurable.fields.map((f) => f.name);

  const config = await getAppConfigCredentials({ organizationId }, app.id);
  if (config && requiredFields.every((f) => !!config.fields[f])) {
    const values: Record<string, string> = {};
    for (const f of requiredFields) values[f] = config.fields[f]!;
    return { values, source: "app_config", appConfigId: config.appConfigId };
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
