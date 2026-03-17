"use server";

import { db } from "@onecli/db";
import { resolveUserId } from "@/lib/actions/resolve-user";
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
  const userId = await resolveUserId();
  return listSecrets(userId);
};

export const createSecret = async (input: CreateSecretInput) => {
  const userId = await resolveUserId();
  return createSecretService(userId, input);
};

export const deleteSecret = async (secretId: string) => {
  const userId = await resolveUserId();
  return deleteSecretService(userId, secretId);
};

export const getDemoInfo = async () => {
  const userId = await resolveUserId();

  const [demoSecret, agent] = await Promise.all([
    db.secret.findFirst({
      where: { userId, name: DEMO_SECRET_NAME },
      select: { id: true },
    }),
    db.agent.findFirst({
      where: { userId, isDefault: true },
      select: { accessToken: true },
    }),
  ]);

  if (!demoSecret || !agent) return null;

  return { agentToken: agent.accessToken };
};

export const updateSecret = async (
  secretId: string,
  input: UpdateSecretInput,
) => {
  const userId = await resolveUserId();
  return updateSecretService(userId, secretId, input);
};
