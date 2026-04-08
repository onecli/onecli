"use server";

import { db } from "@onecli/db";
import { resolveUser } from "@/lib/actions/resolve-user";
import { DEMO_SECRET_NAME } from "@/lib/constants";
import { API_BASE_URL, APP_URL } from "@/lib/env";
import { seedDemoSecret as seedDemoSecretService } from "@/lib/services/secret-service";
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
  const { userId, userEmail, accountId } = await resolveUser();
  return withAudit(
    () => createSecretService(accountId, input),
    (secret) => ({
      accountId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.SECRET,
      metadata: { secretId: secret.id, name: input.name, type: input.type },
    }),
  );
};

export const deleteSecret = async (secretId: string): Promise<void> => {
  const { userId, userEmail, accountId } = await resolveUser();
  return withAudit(
    () => deleteSecretService(accountId, secretId),
    () => ({
      accountId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.SECRET,
      metadata: { secretId },
    }),
  );
};

export const getInstallInfo = async () => {
  const { accountId, userId } = await resolveUser();

  const [apiKey, agent] = await Promise.all([
    db.apiKey.findFirst({
      where: { userId, accountId },
      select: { key: true },
    }),
    db.agent.findFirst({
      where: { accountId, isDefault: true },
      select: { accessToken: true },
    }),
  ]);

  return {
    apiKey: apiKey?.key ?? null,
    agentToken: agent?.accessToken ?? null,
    gatewayUrl: API_BASE_URL,
    appUrl: APP_URL,
  };
};

export const seedDemoSecret = async () => {
  const { accountId } = await resolveUser();
  await seedDemoSecretService(accountId);
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

  return {
    agentToken: agent.accessToken,
    gatewayUrl: API_BASE_URL,
  };
};

export const updateSecret = async (
  secretId: string,
  input: UpdateSecretInput,
): Promise<void> => {
  const { userId, userEmail, accountId } = await resolveUser();
  return withAudit(
    () => updateSecretService(accountId, secretId, input),
    () => ({
      accountId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.SECRET,
      metadata: { secretId },
    }),
  );
};
