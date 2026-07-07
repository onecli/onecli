import { db, Prisma } from "@onecli/db";
import { getCrypto } from "../providers";
import { logger } from "../lib/logger";
import { ServiceError } from "./errors";
import type { OAuthConfigField } from "../apps/types";
import type { ResourceScope } from "./resource-scope";
import {
  scopeWhere,
  scopeCreate,
  appConfigKey,
  isOrgScope,
} from "./resource-scope";

const disconnectIfConnected = async (
  scope: ResourceScope,
  provider: string,
  // When the caller already loaded the config row (delete/toggle fetch it for
  // their existence check), pass its id to skip re-resolving it for the sweep.
  knownConfigId?: string,
) => {
  await db.appConnection.deleteMany({
    where: { ...scopeWhere(scope), provider },
  });

  // Org-scope removal also drops the project connections this config minted:
  // their OAuth refresh tokens are bound to the client credentials being
  // removed, so refresh would fail against a different client. The provenance
  // FK finds exactly those — across every project, and nothing this config
  // didn't mint. OSS never has org rows, so this arm is inert there.
  if (isOrgScope(scope)) {
    const configId =
      knownConfigId ??
      (
        await db.appConfig.findUnique({
          where: appConfigKey(scope, provider),
          select: { id: true },
        })
      )?.id;
    if (configId) {
      await db.appConnection.deleteMany({
        where: { appConfigId: configId, scope: "project" },
      });
    }
  }
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

export interface AppConfigCredentials {
  /** Id of the AppConfig row these credentials came from (provenance link). */
  appConfigId: string;
  fields: Record<string, string>;
}

export const getAppConfigCredentials = async (
  scope: ResourceScope,
  provider: string,
): Promise<AppConfigCredentials | null> => {
  const config = await db.appConfig.findUnique({
    where: appConfigKey(scope, provider),
    select: { id: true, settings: true, credentials: true, enabled: true },
  });

  if (!config || !config.enabled) return null;

  const settings = (config.settings as Record<string, string>) ?? {};

  if (!config.credentials) {
    return { appConfigId: config.id, fields: settings };
  }

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
    return { appConfigId: config.id, fields: settings };
  }

  return { appConfigId: config.id, fields: { ...settings, ...decrypted } };
};

/**
 * Decrypted credential fields for a specific AppConfig row by id — used by the
 * provenance-link refresh paths, where a connection must refresh with the
 * config that minted it (its refresh token is bound to that OAuth client).
 * Returns null when the row is missing or disabled, mirroring the gateway's
 * `find_app_config_by_connection` (`enabled = true`).
 */
export const getAppConfigCredentialsById = async (
  appConfigId: string,
): Promise<Record<string, string> | null> => {
  const config = await db.appConfig.findUnique({
    where: { id: appConfigId },
    select: { settings: true, credentials: true, enabled: true },
  });

  if (!config || !config.enabled) return null;

  const settings = (config.settings as Record<string, string>) ?? {};

  if (!config.credentials) return settings;

  try {
    const decrypted = JSON.parse(
      await getCrypto().decrypt(config.credentials),
    ) as Record<string, string>;
    return { ...settings, ...decrypted };
  } catch (err) {
    logger.warn(
      { err, appConfigId },
      "failed to decrypt app config credentials",
    );
    return settings;
  }
};

/**
 * The blast radius of removing or replacing an org-scoped app config: the
 * connections that would be disconnected. `orgConnections` are the config's own
 * org-scoped connections; `projectConnections` are the project connections it
 * minted (the provenance FK), across every project. Surfaced in the org admin's
 * confirm dialog — org scope only (a project config has no cross-project
 * fan-out).
 */
export const countAppConfigDependents = async (
  scope: ResourceScope,
  provider: string,
): Promise<{ orgConnections: number; projectConnections: number }> => {
  const [orgConnections, row] = await Promise.all([
    db.appConnection.count({ where: { ...scopeWhere(scope), provider } }),
    db.appConfig.findUnique({
      where: appConfigKey(scope, provider),
      select: { id: true },
    }),
  ]);

  const projectConnections = row
    ? await db.appConnection.count({
        where: { appConfigId: row.id, scope: "project" },
      })
    : 0;

  return { orgConnections, projectConnections };
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

  // Disconnect BEFORE deleting the row: onDelete SetNull would null the
  // provenance FKs first and blind the org-scope dependent sweep.
  await disconnectIfConnected(scope, provider, config.id);

  await db.appConfig.delete({
    where: appConfigKey(scope, provider),
  });
};

export const hasAppConfig = async (
  scope: ResourceScope,
  provider: string,
): Promise<boolean> => {
  const config = await db.appConfig.findUnique({
    where: appConfigKey(scope, provider),
    select: { enabled: true, credentials: true },
  });
  // "Configured" means usable: an enabled row must also carry credentials, or
  // the resolver rejects it at connect time (the app grid/detail apply the same
  // gate), which would otherwise let a half-saved config reach a failing OAuth.
  return !!config?.enabled && !!config.credentials;
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

  await disconnectIfConnected(scope, provider, config.id);

  return db.appConfig.update({
    where: appConfigKey(scope, provider),
    data: { enabled },
    select: { id: true, enabled: true },
  });
};
