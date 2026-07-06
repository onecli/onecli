"use server";

import { db } from "@onecli/db";
import { resolveProjectContext } from "@/lib/actions/resolve-user";
import { hasAppConfig as hasAppConfigService } from "@onecli/api/services/app-config-service";

// Server-side seed for the RSC app pages (`hasAppConfig` prop). All other
// app-config reads/writes go through the /v1 API client (lib/api/app-config)
// and the use-app-config hooks.
//
// With `orgId` (the org-scoped connect popup), the seed reads the org-level
// config instead — gated on the caller's membership in that org.
export const checkAppConfigExists = async (
  provider: string,
  orgId?: string,
): Promise<boolean> => {
  const { userId, projectId } = await resolveProjectContext();

  if (orgId) {
    const membership = await db.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: orgId, userId } },
      select: { organizationId: true },
    });
    if (!membership) return false;
    return hasAppConfigService({ organizationId: orgId }, provider);
  }

  return hasAppConfigService({ projectId }, provider);
};
