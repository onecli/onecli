import { getRuntimeConfig } from "@/lib/runtime-config";

export type AuthMode = "cloud" | "oauth" | "local";

export interface AuthProviderInfo {
  id: string;
  name: string;
}

export const getAuthMode = (): AuthMode => getRuntimeConfig().authMode;

export const isOAuthConfigured = (): boolean =>
  getRuntimeConfig().oauthConfigured;

export const getAuthProvider = (): AuthProviderInfo => {
  const { authProviderId, authProviderName } = getRuntimeConfig();
  return { id: authProviderId, name: authProviderName };
};
