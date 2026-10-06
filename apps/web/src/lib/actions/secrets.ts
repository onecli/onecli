"use server";

import { db } from "@onecli/db";
import { resolveWorkspaceContext } from "@/lib/actions/resolve-user";
import type { ResolveOptions } from "@/lib/actions/resolve-user";
import { apiOrigin, appOrigin } from "@onecli/api/lib/public-origins";
import {
  listSecrets,
  createSecret as createSecretService,
  deleteSecret as deleteSecretService,
  updateSecret as updateSecretService,
  type CreateSecretInput,
  type UpdateSecretInput,
} from "@onecli/api/services/secret-service";
import { ensureApiKey } from "@onecli/api/services/api-key-service";
import {
  withAudit,
  recordAuditEvent,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@onecli/api/services/audit-service";

export const getSecrets = async () => {
  const { workspaceId } = await resolveWorkspaceContext();
  return listSecrets({ workspaceId });
};

export const createSecret = async (
  input: CreateSecretInput,
  options?: ResolveOptions,
) => {
  const { userId, userEmail, workspaceId } =
    await resolveWorkspaceContext(options);
  return withAudit(
    () => createSecretService({ workspaceId }, input, userId),
    (secret) => ({
      workspaceId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.SECRET,
      metadata: { secretId: secret.id, name: input.name, type: input.type },
    }),
  );
};

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

export const hasAnthropicSecret = async (
  options?: ResolveOptions,
): Promise<boolean> => {
  const { workspaceId } = await resolveWorkspaceContext(options);
  const secret = await db.secret.findFirst({
    where: { workspaceId, type: "anthropic" },
    select: { id: true },
  });
  return !!secret;
};

export const hasOpenaiSecret = async (): Promise<boolean> => {
  const { workspaceId } = await resolveWorkspaceContext();
  const secret = await db.secret.findFirst({
    where: { workspaceId, type: "openai" },
    select: { id: true },
  });
  return !!secret;
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
