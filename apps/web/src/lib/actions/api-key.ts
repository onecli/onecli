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
  const { userId, accountId } = await resolveUser();
  return getApiKeyService(userId, accountId);
};

export const regenerateApiKey = async () => {
  const { userId, userEmail, accountId } = await resolveUser();
  return withAudit(
    () => regenerateApiKeyService(userId, accountId),
    () => ({
      accountId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.REGENERATE,
      service: AUDIT_SERVICES.API_KEY,
    }),
  );
};
