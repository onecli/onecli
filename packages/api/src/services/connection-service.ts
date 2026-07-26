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
  options?: {
    scopes?: string[];
    metadata?: Record<string, unknown>;
    label?: string;
    /** AppConfig row that minted these credentials; null for env/no-config. */
    appConfigId?: string;
  },
) => {
  const encryptedCredentials = await getCrypto().encrypt(
    JSON.stringify(credentials),
  );

  return db.appConnection.create({
    data: {
      ...scopeCreate(scope),
      provider,
      status: "connected",
      label: options?.label || extractLabel(options?.metadata),
      credentials: encryptedCredentials,
      scopes: options?.scopes ?? [],
      metadata: (options?.metadata as Prisma.InputJsonValue) ?? undefined,
      appConfigId: options?.appConfigId ?? null,
    },
    select: { id: true, provider: true, status: true, label: true },
  });
};

export const reconnectConnection = async (
  scope: ResourceScope,
  connectionId: string,
  credentials: Record<string, unknown>,
  options?: {
    scopes?: string[];
    metadata?: Record<string, unknown>;
    label?: string;
    /** AppConfig row that minted these credentials; null for env/no-config. */
    appConfigId?: string;
  },
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

  // Provenance is rewritten only when the caller expresses one: a re-mint
  // passes `appConfigId` (a value to link, or `undefined` to clear a stale
  // link); a bare token-persist omits the key entirely so the existing link is
  // preserved (Prisma treats an absent field as "leave unchanged").
  const provenanceUpdate =
    options && "appConfigId" in options
      ? { appConfigId: options.appConfigId ?? null }
      : {};

  return db.appConnection.update({
    where: { id: existing.id },
    data: {
      status: "connected",
      label:
        options?.label || (extractLabel(options?.metadata) ?? existing.label),
      credentials: encryptedCredentials,
      scopes: options?.scopes ?? undefined,
      metadata: (options?.metadata as Prisma.InputJsonValue) ?? undefined,
      ...provenanceUpdate,
    },
    select: { id: true, provider: true, status: true, label: true },
  });
};

/**
 * Record which AppConfig minted a connection, after the fact — used by the
 * credentials-import path, where the project config row is saved only after the
 * connection is created. Scope-guarded so it can only touch the caller's own row.
 */
export const linkConnectionToAppConfig = async (
  scope: ResourceScope,
  connectionId: string,
  appConfigId: string,
) => {
  await db.appConnection.updateMany({
    where: scopeOwnership(scope, connectionId),
    data: { appConfigId },
  });
};

export const updateConnectionLabel = async (
  scope: ResourceScope,
  connectionId: string,
  label: string,
) => {
  const existing = await db.appConnection.findFirst({
    where: scopeOwnership(scope, connectionId),
    select: { id: true },
  });

  if (!existing) {
    throw new ServiceError("NOT_FOUND", "Connection not found");
  }

  return db.appConnection.update({
    where: { id: existing.id },
    data: { label },
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
