"use server";

import { db } from "@onecli/db";
import { resolveUser } from "@/lib/actions/resolve-user";
import { DEMO_SECRET_NAME } from "@/lib/constants";
import { APP_URL, GATEWAY_BASE_URL } from "@/lib/env";
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
    gatewayUrl: GATEWAY_BASE_URL,
    appUrl: APP_URL,
  };
};

export const seedDemoSecret = async () => {
  const { accountId } = await resolveUser();
  await seedDemoSecretService(accountId);
};

export const hasAnthropicSecret = async (): Promise<boolean> => {
  const { accountId } = await resolveUser();
  const secret = await db.secret.findFirst({
    where: { accountId, type: "anthropic" },
    select: { id: true },
  });
  return !!secret;
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
    gatewayUrl: GATEWAY_BASE_URL,
  };
};

export const validateAnthropicKey = async (
  key: string,
): Promise<{ valid: boolean; error?: string }> => {
  // OAuth subscription tokens can't be validated against /v1/models,
  // so we only do format validation for those.
  if (key.startsWith("sk-ant-oat")) {
    return { valid: true };
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
    });

    if (res.ok) return { valid: true };

    if (res.status === 401) {
      return { valid: false, error: "Invalid API key." };
    }
    if (res.status === 403) {
      return {
        valid: false,
        error: "This key doesn't have permission to access the API.",
      };
    }

    return {
      valid: false,
      error: `Anthropic API returned an unexpected status (${res.status}).`,
    };
  } catch {
    return {
      valid: false,
      error: "Could not reach Anthropic API to validate the key.",
    };
  }
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
