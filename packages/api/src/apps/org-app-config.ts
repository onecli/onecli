import { db } from "@onecli/db";
import type { OrgAppConfigProvider } from "../providers";
import { getAppConfig } from "../services/app-config-service";
import { resolveOrgAppCredentials } from "./resolve-org-credentials";

/**
 * Org-level app-config reads backing the workspace → org → env fallback
 * (registered on the `orgAppConfig` DI seam by the cloud edition).
 *
 * `resolveCredentials` delegates to `resolveOrgAppCredentials`, which itself
 * falls back org row → env — so when this provider is registered, the shared
 * resolver's own env tail is unreachable. That's intentional: the env values
 * and `source: "env"` are identical either way.
 */
export const orgAppConfig: OrgAppConfigProvider = {
  resolveCredentials: (organizationId, app) =>
    resolveOrgAppCredentials(organizationId, app),

  getEnabledConfig: async (organizationId, provider) => {
    const config = await getAppConfig({ organizationId }, provider);
    // Only a *usable* config counts as configured: an enabled row without
    // stored credentials (e.g. clientId saved without clientSecret) is rejected
    // by the resolver at authorize/refresh, so surfacing it as configured would
    // make the grid/detail/config signals disagree with what connect does.
    // Mirrors the workspace tier's own `hasCredentials` gate.
    if (!config?.enabled || !config.hasCredentials) return null;
    return { hasCredentials: true };
  },

  listEnabledConfigs: async (organizationId) => {
    const configs = await db.appConfig.findMany({
      where: {
        organizationId,
        scope: "organization",
        enabled: true,
        credentials: { not: null },
      },
      select: { provider: true },
    });
    return Object.fromEntries(
      configs.map((c) => [c.provider, { hasCredentials: true }]),
    );
  },
};
