import { db, Prisma } from "@onecli/db";
import { getCrypto } from "../providers";
import { ServiceError } from "./errors";
import type { ResourceScope } from "./resource-scope";
import { scopeWhere, scopeCreate, scopeOwnership } from "./resource-scope";

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

const CONNECTION_SELECT = {
  id: true,
  provider: true,
  label: true,
  status: true,
  scopes: true,
  scope: true,
  metadata: true,
  connectedAt: true,
} as const;

export const listConnections = async (scope: ResourceScope) => {
  return db.appConnection.findMany({
    where: scopeWhere(scope),
    select: CONNECTION_SELECT,
    orderBy: { connectedAt: "desc" },
  });
};

export const listConnectionsByProvider = async (
  scope: ResourceScope,
  provider: string,
) => {
  return db.appConnection.findMany({
    where: { ...scopeWhere(scope), provider },
    select: CONNECTION_SELECT,
    orderBy: { connectedAt: "desc" },
  });
};

export const createConnection = async (
  scope: ResourceScope,
  provider: string,
  credentials: Record<string, unknown>,
  options?: { scopes?: string[]; metadata?: Record<string, unknown> },
) => {
  const encryptedCredentials = await getCrypto().encrypt(
    JSON.stringify(credentials),
  );

  return db.appConnection.create({
    data: {
      ...scopeCreate(scope),
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

export const reconnectConnection = async (
  scope: ResourceScope,
  connectionId: string,
  credentials: Record<string, unknown>,
  options?: { scopes?: string[]; metadata?: Record<string, unknown> },
) => {
  const existing = await db.appConnection.findFirst({
    where: scopeOwnership(scope, connectionId),
    select: { id: true, label: true },
  });

  if (!existing) {
    throw new ServiceError("NOT_FOUND", "Connection not found");
  }

  const encryptedCredentials = await getCrypto().encrypt(
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

export const deleteConnection = async (
  scope: ResourceScope,
  connectionId: string,
) => {
  const connection = await db.appConnection.findFirst({
    where: scopeOwnership(scope, connectionId),
    select: { id: true },
  });

  if (!connection) {
    throw new ServiceError("NOT_FOUND", "Connection not found");
  }

  await db.appConnection.delete({
    where: { id: connection.id },
  });
};
