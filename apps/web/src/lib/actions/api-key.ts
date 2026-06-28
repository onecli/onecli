"use server";

import { resolveProjectContext } from "@/lib/actions/resolve-user";
import {
  ensureApiKey as ensureApiKeyService,
  regenerateApiKey as regenerateApiKeyService,
} from "@onecli/api/services/api-key-service";
import {
  withAudit,
  recordAuditEvent,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@onecli/api/services/audit-service";

export const getApiKey = async () => {
  const { userId, userEmail, projectId } = await resolveProjectContext();
  const { apiKey, created } = await ensureApiKeyService(userId, { projectId });
  if (created) {
    await recordAuditEvent({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.API_KEY,
      metadata: { scope: "project", autoProvisioned: true },
    });
  }
  return { apiKey };
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
