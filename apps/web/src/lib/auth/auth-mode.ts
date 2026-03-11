import { getRuntimeConfig } from "@/lib/runtime-config";

export type AuthMode = "cloud" | "oauth" | "local";

export const getAuthMode = (): AuthMode => getRuntimeConfig().authMode;

export const isOAuthConfigured = (): boolean =>
  getRuntimeConfig().oauthConfigured;
