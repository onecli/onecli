"use server";

import { resolveWorkspaceContext } from "@/lib/actions/resolve-user";
import { resolveOrgContext } from "@/lib/actions/resolve-user";
import { hasAppConfig as hasAppConfigService } from "@onecli/api/services/app-config-service";

// Server-side seed for the RSC app pages (`hasAppConfig` prop). All other
// app-config reads/writes go through the /v1 API client (lib/api/app-config)
// and the use-app-config hooks.
//
// Includes the org tier of the workspace → org → env credential chain: a workspace
// with no enabled config row of its own reports the organization-level config
// as configured. Org rows exist in every edition, so the fallback runs
// unconditionally. RSC/server-action code can't consult the API package's
// `orgAppConfig` DI seam (that registry is initialized by the Hono app's
// module graph), so the fallback lives here.
export const checkAppConfigExists = async (
  provider: string,
  orgId?: string,
): Promise<boolean> => {
  if (orgId) {
    // The org-connect popup carries ?orgId (bridged to x-organization-id) but no
    // workspace, so resolveWorkspaceContext would throw "X-Workspace-Id header is
    // required" — silently caught upstream, wrongly reporting "Configuration
    // required". resolveOrgContext resolves the org from that same header and
    // only returns it when the caller is a member (a non-member throws → caught
    // → false), so it both fixes the popup and gates access without a workspace.
    const { organizationId } = await resolveOrgContext();
    return hasAppConfigService({ organizationId }, provider);
  }

  const { workspaceId, organizationId } = await resolveWorkspaceContext();
  if (await hasAppConfigService({ workspaceId }, provider)) return true;
  return hasAppConfigService({ organizationId }, provider);
};
