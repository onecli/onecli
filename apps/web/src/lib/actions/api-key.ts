"use server";

import { resolveWorkspaceContext } from "@/lib/actions/resolve-user";
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
  const { userId, userEmail, workspaceId } = await resolveWorkspaceContext();
  const { apiKey, created } = await ensureApiKeyService(userId, {
    workspaceId,
  });
  if (created) {
    await recordAuditEvent({
      workspaceId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.API_KEY,
      metadata: { scope: "workspace", autoProvisioned: true },
    });
  }
  return { apiKey };
};

export const regenerateApiKey = async () => {
  const { userId, userEmail, workspaceId } = await resolveWorkspaceContext();
  return withAudit(
    () => regenerateApiKeyService(userId, { workspaceId }),
    () => ({
      workspaceId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.REGENERATE,
      service: AUDIT_SERVICES.API_KEY,
    }),
  );
};
