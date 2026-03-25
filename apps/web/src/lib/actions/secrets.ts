"use server";

import { db } from "@onecli/db";
import { resolveUser } from "@/lib/actions/resolve-user";
import { DEMO_SECRET_NAME } from "@/lib/constants";
import {
  listSecrets,
  createSecret as createSecretService,
  deleteSecret as deleteSecretService,
  updateSecret as updateSecretService,
  type CreateSecretInput,
  type UpdateSecretInput,
} from "@/lib/services/secret-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@/lib/services/audit-service";

export const getSecrets = async () => {
  const { accountId } = await resolveUser();
  return listSecrets(accountId);
};

export const createSecret = async (input: CreateSecretInput) => {
  const { userId, accountId } = await resolveUser();
  return withAudit(
    () => createSecretService(accountId, input),
    (secret) => ({
      accountId,
      userId,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.SECRET,
      metadata: { secretId: secret.id, name: input.name, type: input.type },
    }),
  );
};

export const deleteSecret = async (secretId: string): Promise<void> => {
  const { userId, accountId } = await resolveUser();
  return withAudit(
    () => deleteSecretService(accountId, secretId),
    () => ({
      accountId,
      userId,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.SECRET,
      metadata: { secretId },
    }),
  );
};

export const getDemoInfo = async () => {
  const { accountId } = await resolveUser();

  const [demoSecret, agent] = await Promise.all([
    db.secret.findFirst({
      where: { accountId, name: DEMO_SECRET_NAME },
      select: { id: true },
    }),
    db.agent.findFirst({
      where: { accountId, isDefault: true },
      select: { accessToken: true },
    }),
  ]);

  if (!demoSecret || !agent) return null;

  const gatewayHost = process.env.GATEWAY_HOST ?? "localhost";
  const gatewayPort = process.env.GATEWAY_PORT ?? "10255";

  return {
    agentToken: agent.accessToken,
    gatewayUrl: `${gatewayHost}:${gatewayPort}`,
  };
};

export const updateSecret = async (
  secretId: string,
  input: UpdateSecretInput,
): Promise<void> => {
  const { userId, accountId } = await resolveUser();
  return withAudit(
    () => updateSecretService(accountId, secretId, input),
    () => ({
      accountId,
      userId,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.SECRET,
      metadata: { secretId },
    }),
  );
};
