"use server";

import { resolveUser } from "@/lib/actions/resolve-user";
import {
  getApiKey as getApiKeyService,
  regenerateApiKey as regenerateApiKeyService,
} from "@/lib/services/api-key-service";

export const getApiKey = async () => {
  const { userId, accountId } = await resolveUser();
  return getApiKeyService(userId, accountId);
};

export const regenerateApiKey = async () => {
  const { userId, accountId } = await resolveUser();
  return regenerateApiKeyService(userId, accountId);
};
