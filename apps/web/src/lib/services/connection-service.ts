import { db, Prisma } from "@onecli/db";
import { cryptoService } from "@/lib/crypto";
import { ServiceError } from "@/lib/services/errors";

/**
 * Extract a human-readable label from connection metadata.
 */
export const extractLabel = (
  metadata?: Record<string, unknown>,
): string | null => {
  const email = metadata?.email;
  const username = metadata?.username;
  const name = metadata?.name;
  if (typeof email === "string" && email) return email;
  if (typeof username === "string" && username) return username;
  if (typeof name === "string" && name) return name;
  return null;
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
