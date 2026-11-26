import { db, Prisma } from "@onecli/db";
import { getCrypto } from "../providers";
import { logger } from "../lib/logger";
import { ServiceError } from "./errors";
import type { OAuthConfigField } from "../apps/types";
import {
  configKeyFor,
  expandConfigKeys,
  isOAuthClientGroupId,
  providersForConfigKey,
} from "../apps/oauth/groups";
import type { ResourceScope } from "./resource-scope";
import {
  scopeWhere,
  scopeCreate,
  appConfigKey,
  isOrgScope,
} from "./resource-scope";

/*
 * Every public function here takes `provider` as either an app id or a vendor
 * group id ("google"). Writes and the config's own reads go through
 * `configKeyFor`, so saving on Gmail stores (and reading on Drive finds) the
 * single `google` row. Credential *resolution* (which also honours legacy
 * per-app rows) lives in `resolveAppCredentials`, not here.
 */

/** Connection-provider filter for a config key (`in` all members for a group). */
const providerFilter = (key: string) => {
  const providers = providersForConfigKey(key);
  return providers.length === 1 ? providers[0]! : { in: providers };
};

/**
 * The key of the row that currently configures `provider` in this scope: the
 * vendor group row when present, else a legacy per-app row saved before
 * grouping (so the UI can still show, toggle, or remove it), else the group key.
 */
const existingKeyFor = async (
  scope: ResourceScope,
  provider: string,
): Promise<string> => {
  const key = configKeyFor(provider);
  if (key === provider) return key;
  const groupRow = await db.appConfig.findUnique({
    where: appConfigKey(scope, key),
    select: { id: true },
  });
  if (groupRow) return key;
  const legacyRow = await db.appConfig.findUnique({
    where: appConfigKey(scope, provider),
    select: { id: true },
  });
  return legacyRow ? provider : key;
};

const disconnectIfConnected = async (
  scope: ResourceScope,
  key: string,
  // When the caller already loaded the config row (delete/toggle fetch it for
  // their existence check), pass its id to skip re-resolving it for the sweep.
  knownConfigId?: string,
  // True when this change turns an org vendor client ON (save, toggle-on).
  enabling = false,
) => {
  // Org-scope removal also drops the workspace connections this config minted:
  // their OAuth refresh tokens are bound to the client credentials being
  // removed, so refresh would fail against a different client. The provenance
  // FK finds exactly those — across every workspace, and nothing this config
  // didn't mint. OSS never has org rows, so this arm is inert there.
  const orgConfigId = isOrgScope(scope)
    ? (knownConfigId ??
      (
        await db.appConfig.findUnique({
          where: appConfigKey(scope, key),
          select: { id: true },
        })
      )?.id)
    : undefined;

  // A group key covers every member app: their connections were minted with
  // the shared client being replaced or removed.
  await db.appConnection.deleteMany({
    where: { ...scopeWhere(scope), provider: providerFilter(key) },
  });
  if (orgConfigId) {
    await db.appConnection.deleteMany({
      where: { appConfigId: orgConfigId, scope: "workspace" },
    });
  }
  if (enabling) {
    const ids = await platformMintedConnectionIds(scope, key);
    if (ids.length > 0) {
      await db.appConnection.deleteMany({ where: { id: { in: ids } } });
    }
  }
};

/**
 * Workspace connections an org vendor client is about to take over: minted by
 * the platform's client (no provenance link), for a member app, in a workspace
 * of this org where that app resolves no client of its own (no usable
 * workspace vendor row or legacy per-app row: enabled AND carrying a secret,
 * the same rule credential resolution applies). Once the org row exists the
 * gateway refreshes them with the org's client, which did not mint their
 * refresh tokens, so refresh would fail. Dropping them turns that into a
 * visible "reconnect". Only for vendor group keys at org scope.
 */
const platformMintedConnectionIds = async (
  scope: ResourceScope,
  key: string,
): Promise<string[]> => {
  if (!isOrgScope(scope) || !isOAuthClientGroupId(key)) return [];
  const members = providersForConfigKey(key);
  const candidates = await db.appConnection.findMany({
    where: {
      scope: "workspace",
      appConfigId: null,
      provider: { in: members },
      workspace: { organizationId: scope.organizationId! },
    },
    select: { id: true, provider: true, workspaceId: true },
  });
  if (candidates.length === 0) return [];
  const overrides = await db.appConfig.findMany({
    where: {
      workspaceId: { in: [...new Set(candidates.map((c) => c.workspaceId!))] },
      enabled: true,
      credentials: { not: null },
      provider: { in: [key, ...members] },
    },
    select: { workspaceId: true, provider: true },
  });
  const own = new Set(overrides.map((o) => `${o.workspaceId}:${o.provider}`));
  return candidates
    .filter(
      (c) =>
        !own.has(`${c.workspaceId}:${key}`) &&
        !own.has(`${c.workspaceId}:${c.provider}`),
    )
    .map((c) => c.id);
};

export const getAppConfig = async (scope: ResourceScope, provider: string) => {
  const key = await existingKeyFor(scope, provider);
  const config = await db.appConfig.findUnique({
    where: appConfigKey(scope, key),
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
 * org-scoped connections; `workspaceConnections` are the workspace connections it
 * minted (the provenance FK), across every workspace. Surfaced in the org admin's
 * confirm dialog — org scope only (a workspace config has no cross-workspace
 * fan-out).
 */
export const countAppConfigDependents = async (
  scope: ResourceScope,
  provider: string,
): Promise<{ orgConnections: number; workspaceConnections: number }> => {
  const key = await existingKeyFor(scope, provider);
  const [orgConnections, row] = await Promise.all([
    db.appConnection.count({
      where: { ...scopeWhere(scope), provider: providerFilter(key) },
    }),
    db.appConfig.findUnique({
      where: appConfigKey(scope, key),
      select: { id: true },
    }),
  ]);

  const [linked, platformMinted] = await Promise.all([
    row
      ? db.appConnection.count({
          where: { appConfigId: row.id, scope: "workspace" },
        })
      : 0,
    // Platform-minted accounts a save/enable of this org vendor client would
    // make reconnect (empty once a first save has already swept them).
    platformMintedConnectionIds(scope, key).then((ids) => ids.length),
  ]);
  const workspaceConnections = linked + platformMinted;

  return { orgConnections, workspaceConnections };
};

export const upsertAppConfig = async (
  scope: ResourceScope,
  provider: string,
  values: Record<string, string>,
  fieldDefinitions: OAuthConfigField[],
) => {
  const key = configKeyFor(provider);
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
    // An empty secret means "keep current": the secret of the row the form
    // showed, which for a grouped app may still be its pre-grouping per-app
    // row. That row is replaced by the group row below, so its secret must
    // carry over or the saved client would have none.
    const existing = await db.appConfig.findUnique({
      where: appConfigKey(scope, await existingKeyFor(scope, provider)),
      select: { credentials: true },
    });
    if (existing?.credentials) {
      encryptedCredentials = existing.credentials;
    }
  }

  await disconnectIfConnected(scope, key, undefined, true);
  if (isOAuthClientGroupId(key)) await removeLegacyMemberRows(scope, key);

  return db.appConfig.upsert({
    where: appConfigKey(scope, key),
    create: {
      ...scopeCreate(scope),
      provider: key,
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
 * Saving a vendor (group) config supersedes any pre-grouping per-app rows for
 * its members in the same scope: otherwise a stale per-app row would keep
 * winning resolution (app-first) for that one app. Their connections were
 * already swept by `disconnectIfConnected`.
 */
const removeLegacyMemberRows = async (scope: ResourceScope, key: string) => {
  const where = {
    ...scopeWhere(scope),
    provider: { in: providersForConfigKey(key) },
  };
  // Org rows also minted workspace connections (provenance FK). Drop those
  // BEFORE the rows go: onDelete SetNull would orphan them, and their refresh
  // tokens are bound to the legacy client being removed.
  if (isOrgScope(scope)) {
    const legacy = await db.appConfig.findMany({ where, select: { id: true } });
    if (legacy.length === 0) return;
    await db.appConnection.deleteMany({
      where: {
        appConfigId: { in: legacy.map((r) => r.id) },
        scope: "workspace",
      },
    });
  }
  await db.appConfig.deleteMany({ where });
};

export const saveAppConfigWithoutDisconnect = async (
  scope: ResourceScope,
  provider: string,
  clientId: string,
  clientSecret: string,
) => {
  const key = configKeyFor(provider);
  const encryptedCredentials = await getCrypto().encrypt(
    JSON.stringify({ clientSecret }),
  );

  return db.appConfig.upsert({
    where: appConfigKey(scope, key),
    create: {
      ...scopeCreate(scope),
      provider: key,
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
  const key = await existingKeyFor(scope, provider);
  const config = await db.appConfig.findUnique({
    where: appConfigKey(scope, key),
    select: { id: true },
  });

  if (!config) {
    throw new ServiceError("NOT_FOUND", "App config not found");
  }

  // Disconnect BEFORE deleting the row: onDelete SetNull would null the
  // provenance FKs first and blind the org-scope dependent sweep.
  await disconnectIfConnected(scope, key, config.id);

  await db.appConfig.delete({
    where: appConfigKey(scope, key),
  });
};

export const hasAppConfig = async (
  scope: ResourceScope,
  provider: string,
): Promise<boolean> => {
  const config = await db.appConfig.findUnique({
    where: appConfigKey(scope, await existingKeyFor(scope, provider)),
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
  // A group row configures every member app.
  return expandConfigKeys(configs.map((c) => c.provider));
};

export const toggleAppConfigEnabled = async (
  scope: ResourceScope,
  provider: string,
  enabled: boolean,
) => {
  const key = await existingKeyFor(scope, provider);
  const config = await db.appConfig.findUnique({
    where: appConfigKey(scope, key),
    select: { id: true },
  });

  if (!config) {
    throw new ServiceError("NOT_FOUND", "App config not found");
  }

  await disconnectIfConnected(scope, key, config.id, enabled);

  return db.appConfig.update({
    where: appConfigKey(scope, key),
    data: { enabled },
    select: { id: true, enabled: true },
  });
};
