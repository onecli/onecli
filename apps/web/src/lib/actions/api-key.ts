"use server";

import { resolveProjectContext } from "@/lib/actions/resolve-user";
import {
  getApiKey as getApiKeyService,
  regenerateApiKey as regenerateApiKeyService,
} from "@onecli/api/services/api-key-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@onecli/api/services/audit-service";

export const getApiKey = async () => {
  const { userId, projectId } = await resolveProjectContext();
  return getApiKeyService(userId, { projectId });
};

export const regenerateApiKey = async () => {
  const { userId, userEmail, projectId } = await resolveProjectContext();
  return withAudit(
    () => regenerateApiKeyService(userId, { projectId }),
    () => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.REGENERATE,
      service: AUDIT_SERVICES.API_KEY,
    }),
  );
};
