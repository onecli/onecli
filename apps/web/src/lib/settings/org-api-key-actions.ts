"use server";

import { requireOrgAdminContext } from "@/lib/actions/resolve-user";
import {
  ensureApiKey,
  regenerateApiKey,
} from "@onecli/api/services/api-key-service";
import {
  withAudit,
  recordAuditEvent,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  type AuditService,
} from "@onecli/api/services/audit-service";

export const getOrgApiKey = async () => {
  const { userId, userEmail, organizationId } = await requireOrgAdminContext();
  const { apiKey, created } = await ensureApiKey(userId, { organizationId });
  if (created) {
    await recordAuditEvent({
      organizationId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.API_KEY,
      metadata: { scope: "organization", autoProvisioned: true },
    });
  }
  return { apiKey };
};

export const regenerateOrgApiKey = async () => {
  const { userId, userEmail, organizationId } = await requireOrgAdminContext();
  return withAudit(
    () => regenerateApiKey(userId, { organizationId }),
    () => ({
      organizationId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.REGENERATE,
      service: "org-api-key" as AuditService,
    }),
  );
};
