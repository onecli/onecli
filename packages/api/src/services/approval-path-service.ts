import { db, Prisma } from "@onecli/db";
import { getCrypto } from "../providers";
import { logger } from "../lib/logger";
import { ServiceError } from "./errors";
import type { ResourceScope } from "./resource-scope";
import { scopeWhere, scopeCreate, approvalPathKey } from "./resource-scope";

/**
 * A configurable field for an approval-path channel. `secret: true` fields are
 * encrypted into `credentials`; everything else is stored plainly in `settings`.
 */
export interface ApprovalPathField {
  name: string;
  secret?: boolean;
}

export interface ApprovalPathStatus {
  settings: Record<string, string>;
  hasCredentials: boolean;
  enabled: boolean;
}

export const getApprovalPath = async (
  scope: ResourceScope,
  channel: string,
): Promise<ApprovalPathStatus | null> => {
  const path = await db.approvalPath.findUnique({
    where: approvalPathKey(scope, channel),
    select: { settings: true, credentials: true, enabled: true },
  });

  if (!path) return null;

  return {
    settings: (path.settings as Record<string, string>) ?? {},
    hasCredentials: !!path.credentials,
    enabled: path.enabled,
  };
};

/**
 * Returns every configured approval path for the scope, keyed by channel.
 * Channels with no row are simply absent (the caller applies channel defaults,
 * e.g. "onecli" is treated as enabled when absent).
 */
export const listApprovalPaths = async (
  scope: ResourceScope,
): Promise<Record<string, ApprovalPathStatus>> => {
  const paths = await db.approvalPath.findMany({
    where: scopeWhere(scope),
    select: { channel: true, settings: true, credentials: true, enabled: true },
  });

  return Object.fromEntries(
    paths.map((p) => [
      p.channel,
      {
        settings: (p.settings as Record<string, string>) ?? {},
        hasCredentials: !!p.credentials,
        enabled: p.enabled,
      },
    ]),
  );
};

export const upsertApprovalPath = async (
  scope: ResourceScope,
  channel: string,
  values: Record<string, string>,
  fieldDefinitions: ApprovalPathField[],
) => {
  const plainFields: Record<string, string> = {};
  const providedSecrets: Record<string, string> = {};

  for (const field of fieldDefinitions) {
    const value = values[field.name];
    if (field.secret) {
      if (value) providedSecrets[field.name] = value;
    } else {
      if (value) plainFields[field.name] = value;
    }
  }

  // A channel can have MULTIPLE secret fields stored together in one encrypted
  // `credentials` blob (e.g. ntfy's publishToken + callbackToken). Merge newly-
  // provided secrets OVER the existing decrypted set so a save that re-enters
  // only one secret doesn't wipe the others (a blank field = "keep existing").
  const existing = await db.approvalPath.findUnique({
    where: approvalPathKey(scope, channel),
    select: { credentials: true },
  });

  let mergedSecrets: Record<string, string> = {};
  if (existing?.credentials) {
    try {
      mergedSecrets = JSON.parse(
        await getCrypto().decrypt(existing.credentials),
      ) as Record<string, string>;
    } catch (err) {
      logger.warn(
        { err, ...scope, channel },
        "could not decrypt existing approval path credentials; replacing",
      );
    }
  }
  mergedSecrets = { ...mergedSecrets, ...providedSecrets };

  let encryptedCredentials: string | undefined;
  if (Object.keys(mergedSecrets).length > 0) {
    encryptedCredentials = await getCrypto().encrypt(
      JSON.stringify(mergedSecrets),
    );
  } else if (existing?.credentials) {
    encryptedCredentials = existing.credentials;
  }

  return db.approvalPath.upsert({
    where: approvalPathKey(scope, channel),
    create: {
      ...scopeCreate(scope),
      channel,
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
    select: { id: true, channel: true },
  });
};

export const setApprovalPathEnabled = async (
  scope: ResourceScope,
  channel: string,
  enabled: boolean,
) => {
  // Toggling a channel that was never configured (e.g. disabling the default-on
  // "onecli" path) creates the row so the explicit state is persisted.
  return db.approvalPath.upsert({
    where: approvalPathKey(scope, channel),
    create: {
      ...scopeCreate(scope),
      channel,
      enabled,
    },
    update: { enabled },
    select: { id: true, channel: true, enabled: true },
  });
};

/**
 * Decrypt and return a single saved secret field (e.g. ntfy publishToken) for
 * the "reveal" eye in the UI. Returns null if nothing is stored or decryption
 * fails. The CALLER is responsible for gating this behind an opt-in env flag —
 * this service does not check it.
 */
export const revealApprovalSecret = async (
  scope: ResourceScope,
  channel: string,
  field: string,
): Promise<string | null> => {
  const path = await db.approvalPath.findUnique({
    where: approvalPathKey(scope, channel),
    select: { credentials: true },
  });
  if (!path?.credentials) return null;
  try {
    const secrets = JSON.parse(
      await getCrypto().decrypt(path.credentials),
    ) as Record<string, string>;
    return secrets[field] ?? null;
  } catch (err) {
    logger.warn(
      { err, ...scope, channel, field },
      "could not decrypt approval path secret for reveal",
    );
    return null;
  }
};

export const deleteApprovalPath = async (
  scope: ResourceScope,
  channel: string,
) => {
  const path = await db.approvalPath.findUnique({
    where: approvalPathKey(scope, channel),
    select: { id: true },
  });

  if (!path) {
    throw new ServiceError("NOT_FOUND", "Approval path not found");
  }

  await db.approvalPath.delete({
    where: approvalPathKey(scope, channel),
  });
};

/**
 * Decrypts and returns the merged settings + secret credentials for a channel.
 * Used where the secret values themselves are needed (rarely — the gateway reads
 * these directly from the DB in Rust). Returns null when disabled/absent.
 */
export const getApprovalPathCredentials = async (
  scope: ResourceScope,
  channel: string,
): Promise<Record<string, string> | null> => {
  const path = await db.approvalPath.findUnique({
    where: approvalPathKey(scope, channel),
    select: { settings: true, credentials: true, enabled: true },
  });

  if (!path || !path.enabled) return null;

  const settings = (path.settings as Record<string, string>) ?? {};
  if (!path.credentials) return settings;

  let decrypted: Record<string, string>;
  try {
    decrypted = JSON.parse(
      await getCrypto().decrypt(path.credentials),
    ) as Record<string, string>;
  } catch (err) {
    logger.warn(
      { err, ...scope, channel },
      "failed to decrypt approval path credentials",
    );
    return settings;
  }

  return { ...settings, ...decrypted };
};
