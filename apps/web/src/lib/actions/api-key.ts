"use server";

import { resolveUserId } from "@/lib/actions/resolve-user";
import {
  getApiKey as getApiKeyService,
  regenerateApiKey as regenerateApiKeyService,
} from "@/lib/services/api-key-service";

export const getApiKey = async () => {
  const userId = await resolveUserId();
  return getApiKeyService(userId);
};

export const regenerateApiKey = async () => {
  const userId = await resolveUserId();
  return regenerateApiKeyService(userId);
};
