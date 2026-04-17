import { getAppConfigCredentials } from "@/lib/services/app-config-service";
import type { AppDefinition, OAuthConfigField } from "./types";

export interface ResolvedCredentials {
  clientId: string;
  clientSecret: string;
  config: Record<string, string>;
  source: "app_config" | "env";
}

const STANDARD_FIELDS = new Set(["clientId", "clientSecret"]);

const resolveField = (
  field: Pick<OAuthConfigField, "name">,
  fromAppConfig: Record<string, string> | null,
  envDefaults: Record<string, string> | undefined,
): string | undefined => {
  const fromConfig = fromAppConfig?.[field.name];
  if (fromConfig) return fromConfig;
  const envVar = envDefaults?.[field.name];
  if (envVar) {
    const fromEnv = process.env[envVar];
    if (fromEnv) return fromEnv;
  }
  return undefined;
};

/**
 * Resolve OAuth credentials for a provider.
 * Resolution chain: AppConfig (user-provided) → env vars (platform defaults) → null.
 * Any field marked `required` in the app definition must resolve to a value.
 */
export const resolveOAuthCredentials = async (
  accountId: string,
  app: AppDefinition,
): Promise<ResolvedCredentials | null> => {
  if (!app.configurable) return null;

  const appConfig = await getAppConfigCredentials(accountId, app.id);
  const envDefaults = app.configurable.envDefaults;

  // clientId/clientSecret must come from the same source — they're a pair
  // bound to a single OAuth App registration. Mixing (e.g. AppConfig clientId
  // with env clientSecret) would produce an invalid pair and fail at exchange.
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  let source: ResolvedCredentials["source"];

  if (appConfig?.clientId && appConfig?.clientSecret) {
    clientId = appConfig.clientId;
    clientSecret = appConfig.clientSecret;
    source = "app_config";
  } else {
    clientId = envDefaults?.clientId
      ? process.env[envDefaults.clientId]
      : undefined;
    clientSecret = envDefaults?.clientSecret
      ? process.env[envDefaults.clientSecret]
      : undefined;
    source = "env";
  }

  if (!clientId || !clientSecret) return null;

  const config: Record<string, string> = {};
  for (const field of app.configurable.fields) {
    if (STANDARD_FIELDS.has(field.name)) continue;
    const value = resolveField(field, appConfig, envDefaults);
    if (value) {
      config[field.name] = value;
    } else if (field.required) {
      return null;
    }
  }

  return { clientId, clientSecret, config, source };
};
