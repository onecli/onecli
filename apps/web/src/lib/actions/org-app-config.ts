"use server";

import { requireOrgAdminContext } from "@/lib/actions/resolve-user";
import { hasAppConfig } from "@onecli/api/services/app-config-service";

// Server-side seed for the org RSC app page (`hasAppConfig` prop). All other
// org app-config reads/writes go through the /v1/org/apps API client
// (lib/api/app-config with scope "organization") and the use-app-config hooks.
export const checkOrgAppConfigExists = async (
  provider: string,
): Promise<boolean> => {
  const { organizationId } = await requireOrgAdminContext();
  return hasAppConfig({ organizationId }, provider);
};
