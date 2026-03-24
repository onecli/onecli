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

export const getSecrets = async () => {
  const { accountId } = await resolveUser();
  return listSecrets(accountId);
};

export const createSecret = async (input: CreateSecretInput) => {
  const { accountId } = await resolveUser();
  return createSecretService(accountId, input);
};

export const deleteSecret = async (secretId: string) => {
  const { accountId } = await resolveUser();
  return deleteSecretService(accountId, secretId);
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
) => {
  const { accountId } = await resolveUser();
  return updateSecretService(accountId, secretId, input);
};
