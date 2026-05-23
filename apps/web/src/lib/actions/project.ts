"use server";

import { resolveUser } from "./resolve-user";
import {
  getProjectPublicUrl as getPublicUrlService,
  updateProjectPublicUrl as updatePublicUrlService,
} from "@onecli/api/services/project-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@onecli/api/services/audit-service";
import { IS_CLOUD } from "@/lib/env";

export const getPublicUrl = async (): Promise<string> => {
  const { projectId } = await resolveUser();
  return getPublicUrlService(projectId);
};

export const updatePublicUrl = async (publicUrl: string | null) => {
  if (IS_CLOUD) {
    throw new Error("Public URL override is not available in Cloud edition");
  }

  if (publicUrl !== null) {
    const trimmed = publicUrl.trim();
    if (!trimmed) {
      publicUrl = null;
    } else {
      try {
        const parsed = new URL(trimmed);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          throw new Error("URL must use http or https protocol");
        }
      } catch (e) {
        if (e instanceof TypeError) {
          throw new Error("Invalid URL format");
        }
        throw e;
      }
    }
  }

  const { userId, userEmail, projectId } = await resolveUser();

  return withAudit(
    () => updatePublicUrlService(projectId, publicUrl),
    () => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.PROJECT,
      metadata: { field: "publicUrl", publicUrl },
    }),
  );
};
