import { db, Prisma } from "@onecli/db";
import { getCrypto } from "../providers";
import { logger } from "../lib/logger";
import { ServiceError } from "./errors";
import type { OAuthConfigField } from "../apps/types";
import type { ResourceScope } from "./resource-scope";
import { scopeWhere, scopeCreate, appConfigKey } from "./resource-scope";

const disconnectIfConnected = async (
  scope: ResourceScope,
  provider: string,
) => {
  await db.appConnection.deleteMany({
    where: { ...scopeWhere(scope), provider },
  });
};

export const getAppConfig = async (scope: ResourceScope, provider: string) => {
  const config = await db.appConfig.findUnique({
    where: appConfigKey(scope, provider),
    select: { settings: true, credentials: true, enabled: true },
  });

  if (!config) return null;

  return {
    settings: (config.settings as Record<string, string>) ?? {},
    hasCredentials: !!config.credentials,
    enabled: config.enabled,
  };
};

export const getAppConfigCredentials = async (
  scope: ResourceScope,
  provider: string,
): Promise<Record<string, string> | null> => {
  const config = await db.appConfig.findUnique({
    where: appConfigKey(scope, provider),
    select: { settings: true, credentials: true, enabled: true },
  });

  if (!config || !config.enabled) return null;

  const settings = (config.settings as Record<string, string>) ?? {};

  if (!config.credentials) return settings;

  let decrypted: Record<string, string>;
  try {
    decrypted = JSON.parse(
      await getCrypto().decrypt(config.credentials),
    ) as Record<string, string>;
  } catch (err) {
    logger.warn(
      { err, ...scope, provider },
      "failed to decrypt app config credentials",
    );
    return settings;
  }

  return { ...settings, ...decrypted };
};

export const upsertAppConfig = async (
  scope: ResourceScope,
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

  let encryptedCredentials: string | undefined;
  if (Object.keys(secretFields).length > 0) {
    encryptedCredentials = await getCrypto().encrypt(
      JSON.stringify(secretFields),
    );
  } else {
    const existing = await db.appConfig.findUnique({
      where: appConfigKey(scope, provider),
      select: { credentials: true },
    });
    if (existing?.credentials) {
      encryptedCredentials = existing.credentials;
    }
  }

  await disconnectIfConnected(scope, provider);

  return db.appConfig.upsert({
    where: appConfigKey(scope, provider),
    create: {
      ...scopeCreate(scope),
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

export const saveAppConfigWithoutDisconnect = async (
  scope: ResourceScope,
  provider: string,
  clientId: string,
  clientSecret: string,
) => {
  const encryptedCredentials = await getCrypto().encrypt(
    JSON.stringify({ clientSecret }),
  );

  return db.appConfig.upsert({
    where: appConfigKey(scope, provider),
    create: {
      ...scopeCreate(scope),
      provider,
      enabled: true,
      settings: { clientId } as Prisma.InputJsonValue,
      credentials: encryptedCredentials,
    },
    update: {
      enabled: true,
      settings: { clientId } as Prisma.InputJsonValue,
      credentials: encryptedCredentials,
    },
    select: { id: true, provider: true },
  });
};

export const deleteAppConfig = async (
  scope: ResourceScope,
  provider: string,
) => {
  const config = await db.appConfig.findUnique({
    where: appConfigKey(scope, provider),
    select: { id: true },
  });

  if (!config) {
    throw new ServiceError("NOT_FOUND", "App config not found");
  }

  await db.appConfig.delete({
    where: appConfigKey(scope, provider),
  });

  await disconnectIfConnected(scope, provider);
};

export const hasAppConfig = async (
  scope: ResourceScope,
  provider: string,
): Promise<boolean> => {
  const config = await db.appConfig.findUnique({
    where: appConfigKey(scope, provider),
    select: { enabled: true },
  });
  return !!config?.enabled;
};

export const listConfiguredProviders = async (
  scope: ResourceScope,
): Promise<string[]> => {
  const configs = await db.appConfig.findMany({
    where: { ...scopeWhere(scope), enabled: true },
    select: { provider: true },
  });
  return configs.map((c) => c.provider);
};

export const toggleAppConfigEnabled = async (
  scope: ResourceScope,
  provider: string,
  enabled: boolean,
) => {
  const config = await db.appConfig.findUnique({
    where: appConfigKey(scope, provider),
    select: { id: true },
  });

  if (!config) {
    throw new ServiceError("NOT_FOUND", "App config not found");
  }

  await disconnectIfConnected(scope, provider);

  return db.appConfig.update({
    where: appConfigKey(scope, provider),
    data: { enabled },
    select: { id: true, enabled: true },
  });
};
