import { getAppConfigCredentials } from "@/lib/services/app-config-service";
import type { AppDefinition } from "./types";

export interface ResolvedCredentials {
  clientId: string;
  clientSecret: string;
  source: "app_config" | "env";
}

/**
 * Resolve OAuth credentials for a provider.
 * Resolution chain: AppConfig (user-provided) → env vars (platform defaults) → null.
 */
export const resolveOAuthCredentials = async (
  accountId: string,
  app: AppDefinition,
): Promise<ResolvedCredentials | null> => {
  if (!app.configurable) return null;

  // 1. Try user-provided AppConfig
  const config = await getAppConfigCredentials(accountId, app.id);
  if (config?.clientId && config?.clientSecret) {
    return {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      source: "app_config",
    };
  }

  // 2. Fall back to platform env vars
  const { envDefaults } = app.configurable;
  const clientId = envDefaults.clientId
    ? process.env[envDefaults.clientId]
    : undefined;
  const clientSecret = envDefaults.clientSecret
    ? process.env[envDefaults.clientSecret]
    : undefined;

  if (clientId && clientSecret) {
    return { clientId, clientSecret, source: "env" };
  }

  return null;
};
