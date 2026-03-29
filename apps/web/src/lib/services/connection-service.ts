import { db, Prisma } from "@onecli/db";
import { cryptoService } from "@/lib/crypto";
import { ServiceError } from "@/lib/services/errors";

/**
 * List all app connections for an account (no credentials returned).
 */
export const listConnections = async (accountId: string) => {
  return db.appConnection.findMany({
    where: { accountId },
    select: {
      id: true,
      provider: true,
      status: true,
      scopes: true,
      metadata: true,
      connectedAt: true,
    },
    orderBy: { connectedAt: "desc" },
  });
};

/**
 * Create or update an app connection with encrypted credentials.
 */
export const upsertConnection = async (
  accountId: string,
  provider: string,
  credentials: Record<string, unknown>,
  options?: { scopes?: string[]; metadata?: Record<string, unknown> },
) => {
  const encryptedCredentials = await cryptoService.encrypt(
    JSON.stringify(credentials),
  );

  return db.appConnection.upsert({
    where: { accountId_provider: { accountId, provider } },
    create: {
      accountId,
      provider,
      status: "connected",
      credentials: encryptedCredentials,
      scopes: options?.scopes ?? [],
      metadata: (options?.metadata as Prisma.InputJsonValue) ?? undefined,
    },
    update: {
      status: "connected",
      credentials: encryptedCredentials,
      scopes: options?.scopes ?? undefined,
      metadata: (options?.metadata as Prisma.InputJsonValue) ?? undefined,
    },
    select: { id: true, provider: true, status: true },
  });
};

/**
 * Delete an app connection.
 */
export const deleteConnection = async (accountId: string, provider: string) => {
  const connection = await db.appConnection.findUnique({
    where: { accountId_provider: { accountId, provider } },
    select: { id: true },
  });

  if (!connection) {
    throw new ServiceError("NOT_FOUND", "Connection not found");
  }

  await db.appConnection.delete({
    where: { accountId_provider: { accountId, provider } },
  });
};
