import { readFileSync } from "fs";
import {
  EDITION,
  GOOGLE_CLIENT_ID,
  NEXTAUTH_SECRET,
  OIDC_ISSUER,
  OIDC_CLIENT_ID,
  OIDC_CLIENT_SECRET,
  OIDC_PROVIDER_NAME,
} from "@/lib/env";

interface RuntimeConfig {
  authMode: "cloud" | "oauth" | "local";
  oauthConfigured: boolean;
  // NextAuth id + login-button label of the active provider (Google when both
  // Google and OIDC are set). Empty when no provider is configured.
  authProviderId: string;
  authProviderName: string;
}

const RUNTIME_CONFIG_PATH = "/app/data/runtime-config.json";

const CLOUD_CONFIG: RuntimeConfig = {
  authMode: "cloud",
  oauthConfigured: true,
  authProviderId: "google",
  authProviderName: "Google",
};

let cached: RuntimeConfig | null = null;

/**
 * Reads the runtime config written by the Docker entrypoint at container start.
 * Cloud edition short-circuits (edition is a build-time decision).
 * Falls back to direct env-var checks for local development (no Docker).
 */
export const getRuntimeConfig = (): RuntimeConfig => {
  if (EDITION === "cloud") return CLOUD_CONFIG;
  if (cached) return cached;

  try {
    cached = JSON.parse(readFileSync(RUNTIME_CONFIG_PATH, "utf-8"));
    return cached!;
  } catch {
    // Local dev (no Docker) — read env vars directly.
    // During Next.js build prerendering this also runs, but since all pages
    // are client-rendered behind auth anyway, the fallback value is fine.
    const oidcConfigured = !!(
      OIDC_ISSUER &&
      OIDC_CLIENT_ID &&
      OIDC_CLIENT_SECRET
    );
    cached = {
      authMode: NEXTAUTH_SECRET ? "oauth" : "local",
      oauthConfigured: !!GOOGLE_CLIENT_ID || oidcConfigured,
      authProviderId: GOOGLE_CLIENT_ID
        ? "google"
        : oidcConfigured
          ? "oidc"
          : "",
      authProviderName: GOOGLE_CLIENT_ID
        ? "Google"
        : oidcConfigured
          ? OIDC_PROVIDER_NAME
          : "",
    };
    return cached;
  }
};
