"use server";

import { resolveWorkspaceContext } from "@/lib/actions/resolve-user";
import type { ResolveOptions } from "@/lib/actions/resolve-user";
import { apiOrigin, appOrigin } from "@onecli/api/lib/public-origins";
import {
  deleteSecret as deleteSecretService,
  updateSecret as updateSecretService,
  type UpdateSecretInput,
} from "@onecli/api/services/secret-service";
import { ensureApiKey } from "@onecli/api/services/api-key-service";
import {
  withAudit,
  recordAuditEvent,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@onecli/api/services/audit-service";

export const deleteSecret = async (secretId: string): Promise<void> => {
  const { userId, userEmail, workspaceId } = await resolveWorkspaceContext();
  return withAudit(
    () => deleteSecretService({ workspaceId }, secretId),
    () => ({
      workspaceId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.SECRET,
      metadata: { secretId },
    }),
  );
};

export const getInstallInfo = async (options?: ResolveOptions) => {
  const { workspaceId, userId, userEmail } =
    await resolveWorkspaceContext(options);

  const keyResult = await ensureApiKey(userId, { workspaceId });

  if (keyResult.created) {
    await recordAuditEvent({
      workspaceId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.API_KEY,
      metadata: { scope: "workspace", autoProvisioned: true },
    });
  }

  return {
    apiKey: keyResult.apiKey,
    appUrl: appOrigin(),
    apiUrl: apiOrigin(),
  };
};

export const updateSecret = async (
  secretId: string,
  input: UpdateSecretInput,
): Promise<void> => {
  const { userId, userEmail, workspaceId } = await resolveWorkspaceContext();
  return withAudit(
    () => updateSecretService({ workspaceId }, secretId, input),
    () => ({
      workspaceId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.SECRET,
      metadata: { secretId },
    }),
  );
};
