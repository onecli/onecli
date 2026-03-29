"use server";

import { db, Prisma } from "@onecli/db";
import { cryptoService } from "@/lib/crypto";
import { ServiceError } from "@/lib/services/errors";
import type { OAuthConfigField } from "@/lib/apps/types";

/**
 * Get the non-secret config and whether encrypted credentials exist.
 * Never returns decrypted secrets — use `getAppConfigCredentials` for that.
 */
export const getAppConfig = async (accountId: string, provider: string) => {
  const config = await db.appConfig.findUnique({
    where: { accountId_provider: { accountId, provider } },
    select: { settings: true, credentials: true, enabled: true },
  });

  if (!config) return null;

  return {
    settings: (config.settings as Record<string, string>) ?? {},
    hasCredentials: !!config.credentials,
    enabled: config.enabled,
  };
};

/**
 * Get the full decrypted credentials (settings + decrypted secrets merged).
 * Internal only — used by resolve-credentials, never exposed to client.
 */
export const getAppConfigCredentials = async (
  accountId: string,
  provider: string,
): Promise<Record<string, string> | null> => {
  const config = await db.appConfig.findUnique({
    where: { accountId_provider: { accountId, provider } },
    select: { settings: true, credentials: true, enabled: true },
  });

  if (!config || !config.enabled) return null;

  const settings = (config.settings as Record<string, string>) ?? {};

  if (!config.credentials) return settings;

  const decrypted = JSON.parse(
    await cryptoService.decrypt(config.credentials),
  ) as Record<string, string>;

  return { ...settings, ...decrypted };
};

/**
 * Create or update an app config, separating secret and non-secret fields.
 * Empty secret values on update are ignored (preserves existing encrypted value).
 */
export const upsertAppConfig = async (
  accountId: string,
  provider: string,
  values: Record<string, string>,
  fieldDefinitions: OAuthConfigField[],
) => {
  const secretFields: Record<string, string> = {};
  const plainFields: Record<string, string> = {};

  for (const field of fieldDefinitions) {
    const value = values[field.name];
    if (field.secret) {
      if (value) secretFields[field.name] = value;
    } else {
      if (value) plainFields[field.name] = value;
    }
  }

  // Merge with existing encrypted secrets if doing a partial update
  let encryptedCredentials: string | undefined;
  if (Object.keys(secretFields).length > 0) {
    encryptedCredentials = await cryptoService.encrypt(
      JSON.stringify(secretFields),
    );
  } else {
    // No new secrets provided — check if we should preserve existing
    const existing = await db.appConfig.findUnique({
      where: { accountId_provider: { accountId, provider } },
      select: { credentials: true },
    });
    if (existing?.credentials) {
      encryptedCredentials = existing.credentials;
    }
  }

  return db.appConfig.upsert({
    where: { accountId_provider: { accountId, provider } },
    create: {
      accountId,
      provider,
      enabled: true,
      settings: plainFields as Prisma.InputJsonValue,
      credentials: encryptedCredentials ?? null,
    },
    update: {
      enabled: true,
      settings: plainFields as Prisma.InputJsonValue,
      ...(encryptedCredentials !== undefined && {
        credentials: encryptedCredentials,
      }),
    },
    select: { id: true, provider: true },
  });
};

/**
 * Delete an app config record.
 */
export const deleteAppConfig = async (accountId: string, provider: string) => {
  const config = await db.appConfig.findUnique({
    where: { accountId_provider: { accountId, provider } },
    select: { id: true },
  });

  if (!config) {
    throw new ServiceError("NOT_FOUND", "App config not found");
  }

  await db.appConfig.delete({
    where: { accountId_provider: { accountId, provider } },
  });
};

/**
 * Lightweight check for whether an AppConfig exists for this provider.
 */
/**
 * Check whether an enabled AppConfig exists for this provider.
 */
export const hasAppConfig = async (
  accountId: string,
  provider: string,
): Promise<boolean> => {
  const config = await db.appConfig.findUnique({
    where: { accountId_provider: { accountId, provider } },
    select: { enabled: true },
  });
  return !!config?.enabled;
};

/**
 * Toggle the enabled state of an AppConfig.
 */
export const toggleAppConfigEnabled = async (
  accountId: string,
  provider: string,
  enabled: boolean,
) => {
  const config = await db.appConfig.findUnique({
    where: { accountId_provider: { accountId, provider } },
    select: { id: true },
  });

  if (!config) {
    throw new ServiceError("NOT_FOUND", "App config not found");
  }

  return db.appConfig.update({
    where: { accountId_provider: { accountId, provider } },
    data: { enabled },
    select: { id: true, enabled: true },
  });
};
