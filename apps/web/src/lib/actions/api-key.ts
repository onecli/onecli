"use server";

import { resolveUser } from "@/lib/actions/resolve-user";
import {
  getApiKey as getApiKeyService,
  regenerateApiKey as regenerateApiKeyService,
} from "@/lib/services/api-key-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@/lib/services/audit-service";

export const getApiKey = async () => {
  const { userId, projectId } = await resolveUser();
  return getApiKeyService(userId, projectId);
};

export const regenerateApiKey = async () => {
  const { userId, userEmail, projectId } = await resolveUser();
  return withAudit(
    () => regenerateApiKeyService(userId, projectId),
    () => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.REGENERATE,
      service: AUDIT_SERVICES.API_KEY,
    }),
  );
};
