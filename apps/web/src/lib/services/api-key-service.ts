import { randomBytes } from "crypto";
import { db } from "@onecli/db";
import { ServiceError } from "@/lib/services/errors";

export const generateApiKey = () => `oc_${randomBytes(32).toString("hex")}`;

/**
 * Get the API key for a user in a specific account.
 */
export const getApiKey = async (userId: string, accountId: string) => {
  const apiKey = await db.apiKey.findFirst({
    where: { userId, accountId },
    select: { key: true },
  });

  if (!apiKey) throw new ServiceError("NOT_FOUND", "API key not found");

  return { apiKey: apiKey.key };
};

/**
 * Regenerate the API key for a user in a specific account.
 */
export const regenerateApiKey = async (userId: string, accountId: string) => {
  const key = generateApiKey();

  const existing = await db.apiKey.findFirst({
    where: { userId, accountId },
    select: { id: true },
  });

  if (existing) {
    await db.apiKey.update({
      where: { id: existing.id },
      data: { key },
    });
  } else {
    await db.apiKey.create({
      data: { key, userId, accountId },
    });
  }

  return { apiKey: key };
};
