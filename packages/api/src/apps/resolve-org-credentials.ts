import type { AppDefinition } from "./types";
import {
  resolveEnvAppCredentials,
  resolveScopedAppConfig,
  type ResolvedAppCredentials,
} from "./resolve-credentials";

/** Org-tier credential resolution: the org's own config, then env defaults. */
export const resolveOrgAppCredentials = async (
  organizationId: string,
  app: AppDefinition,
): Promise<ResolvedAppCredentials | null> =>
  (await resolveScopedAppConfig({ organizationId }, app)) ??
  resolveEnvAppCredentials(app);
