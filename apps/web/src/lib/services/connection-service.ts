import { db, Prisma } from "@onecli/db";
import { cryptoService } from "@/lib/crypto";
import { ServiceError } from "@/lib/services/errors";

const hostFromBaseUrl = (metadata?: Record<string, unknown>): string | null => {
  const baseUrl = metadata?.baseUrl;
  if (typeof baseUrl !== "string" || !baseUrl) return null;
  try {
    return new URL(baseUrl).host || null;
  } catch {
    return null;
  }
};

/**
 * Extract a human-readable display label from connection metadata.
 * Appends ` @ {host}` when metadata includes a `baseUrl` (e.g. GHE).
 */
export const extractLabel = (
  metadata?: Record<string, unknown>,
): string | null => {
  const email = metadata?.email;
  const username = metadata?.username;
  const name = metadata?.name;
  let base: string | null = null;
  if (typeof email === "string" && email) base = email;
  else if (typeof username === "string" && username) base = username;
  else if (typeof name === "string" && name) base = name;

  const host = hostFromBaseUrl(metadata);
  if (base && host) return `${base} @ ${host}`;
  if (base) return base;
  if (host) return host;
  return null;
};

/**
 * Stable identity string used for dedup / equality checks (not display).
 * Returns `${user}@${host}` when baseUrl is present (so same username on
 * different GHE instances doesn't collide), `${user}` otherwise.
 * Does not fall back to `name` — names aren't stable identifiers.
 */
export const connectionIdentity = (
  metadata?: Record<string, unknown>,
): string | null => {
  const email = metadata?.email;
  const username = metadata?.username;
  let base: string | null = null;
  if (typeof email === "string" && email) base = email;
  else if (typeof username === "string" && username) base = username;
  if (!base) return null;

  const host = hostFromBaseUrl(metadata);
  const normalized = base.toLowerCase().trim();
  return host ? `${normalized}@${host.toLowerCase()}` : normalized;
};

/**
 * List all app connections for an account (no credentials returned).
 */
export const listConnections = async (accountId: string) => {
  return db.appConnection.findMany({
    where: { accountId },
    select: {
      id: true,
      provider: true,
      label: true,
      status: true,
      scopes: true,
      metadata: true,
      connectedAt: true,
    },
    orderBy: { connectedAt: "desc" },
  });
};

/**
 * List all app connections for an account filtered by provider.
 */
export const listConnectionsByProvider = async (
  accountId: string,
  provider: string,
) => {
  return db.appConnection.findMany({
    where: { accountId, provider },
    select: {
      id: true,
      provider: true,
      label: true,
      status: true,
      scopes: true,
      metadata: true,
      connectedAt: true,
    },
    orderBy: { connectedAt: "desc" },
  });
};

/**
 * Create a new app connection with encrypted credentials.
 */
export const createConnection = async (
  accountId: string,
  provider: string,
  credentials: Record<string, unknown>,
  options?: { scopes?: string[]; metadata?: Record<string, unknown> },
) => {
  const encryptedCredentials = await cryptoService.encrypt(
    JSON.stringify(credentials),
  );

  return db.appConnection.create({
    data: {
      accountId,
      provider,
      status: "connected",
      label: extractLabel(options?.metadata),
      credentials: encryptedCredentials,
      scopes: options?.scopes ?? [],
      metadata: (options?.metadata as Prisma.InputJsonValue) ?? undefined,
    },
    select: { id: true, provider: true, status: true, label: true },
  });
};

/**
 * Reconnect an existing app connection by updating its credentials.
 */
export const reconnectConnection = async (
  accountId: string,
  connectionId: string,
  credentials: Record<string, unknown>,
  options?: { scopes?: string[]; metadata?: Record<string, unknown> },
) => {
  const existing = await db.appConnection.findFirst({
    where: { id: connectionId, accountId },
    select: { id: true, label: true },
  });

  if (!existing) {
    throw new ServiceError("NOT_FOUND", "Connection not found");
  }

  const encryptedCredentials = await cryptoService.encrypt(
    JSON.stringify(credentials),
  );

  return db.appConnection.update({
    where: { id: existing.id },
    data: {
      status: "connected",
      label: extractLabel(options?.metadata) ?? existing.label,
      credentials: encryptedCredentials,
      scopes: options?.scopes ?? undefined,
      metadata: (options?.metadata as Prisma.InputJsonValue) ?? undefined,
    },
    select: { id: true, provider: true, status: true, label: true },
  });
};

/**
 * Delete an app connection by id.
 */
export const deleteConnection = async (
  accountId: string,
  connectionId: string,
) => {
  const connection = await db.appConnection.findFirst({
    where: { id: connectionId, accountId },
    select: { id: true },
  });

  if (!connection) {
    throw new ServiceError("NOT_FOUND", "Connection not found");
  }

  await db.appConnection.delete({
    where: { id: connection.id },
  });
};
