import { db, Prisma } from "@onecli/db";
import { getCrypto } from "../providers";
import { ServiceError } from "./errors";
import type { ResourceScope } from "./resource-scope";
import { scopeWhere, scopeCreate, scopeOwnership } from "./resource-scope";
import {
  BOUND_HOST_METADATA_KEY,
  deriveBoundHost,
  extractLabel,
} from "../lib/connection-display";
import { bumpHomeForScope } from "./home-sync-service";
import { logger } from "../lib/logger";

/**
 * The metadata to persist: the caller's, with `bound_host` set ONLY from the
 * credential field the gateway gates injection on (never taken from the
 * caller — a supplied key is dropped). The one write point for that key, so
 * every connect path (OAuth callback, API key, credentials import) records it
 * the same way, and no provider's own metadata can steer an agent elsewhere.
 */
const withBoundHost = (
  provider: string,
  credentials: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  const boundHost = deriveBoundHost(provider, credentials);
  if (!metadata && !boundHost) return undefined;
  const rest = Object.fromEntries(
    Object.entries(metadata ?? {}).filter(
      ([key]) => key !== BOUND_HOST_METADATA_KEY,
    ),
  );
  return boundHost ? { ...rest, [BOUND_HOST_METADATA_KEY]: boundHost } : rest;
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

/**
 * Re-render the instructions of every agent that could see this scope's
 * connections: their "connected apps" list (with each host-bound app's host)
 * just changed. Best-effort: the connection write already succeeded, and a
 * missed bump self-heals at the agent's next boot (dispatch composes current
 * truth).
 */
const refreshAgentHomes = (scope: ResourceScope): Promise<void> =>
  bumpHomeForScope(scope).catch((err: unknown) => {
    logger.warn({ err }, "connection change: agent home refresh failed");
  });

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

  const created = await db.appConnection.create({
    data: {
      ...scopeCreate(scope),
      provider,
      status: "connected",
      label: options?.label || extractLabel(options?.metadata),
      credentials: encryptedCredentials,
      scopes: options?.scopes ?? [],
      metadata: withBoundHost(provider, credentials, options?.metadata) as
        | Prisma.InputJsonValue
        | undefined,
      appConfigId: options?.appConfigId ?? null,
    },
    select: { id: true, provider: true, status: true, label: true },
  });
  await refreshAgentHomes(scope);
  return created;
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
    select: { id: true, label: true, provider: true },
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

  // Metadata is replaced only when the caller sends it (a re-auth); a bare
  // token persist leaves it — and its recorded bound host — untouched.
  const metadata = options?.metadata
    ? withBoundHost(existing.provider, credentials, options.metadata)
    : undefined;

  const updated = await db.appConnection.update({
    where: { id: existing.id },
    data: {
      status: "connected",
      label:
        options?.label || (extractLabel(options?.metadata) ?? existing.label),
      credentials: encryptedCredentials,
      scopes: options?.scopes ?? undefined,
      metadata: metadata as Prisma.InputJsonValue | undefined,
      ...provenanceUpdate,
    },
    select: { id: true, provider: true, status: true, label: true },
  });
  // A re-auth can move the bound host (a different org); a bare token
  // persist carries no metadata and changes nothing the agent reads.
  if (options?.metadata) await refreshAgentHomes(scope);
  return updated;
};

/**
 * Record which AppConfig minted a connection, after the fact — used by the
 * credentials-import path, where the workspace config row is saved only after the
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

  const updated = await db.appConnection.update({
    where: { id: existing.id },
    data: { label },
    select: { id: true, provider: true, status: true, label: true },
  });
  // The label is what the agent's connected-apps list names the account by.
  await refreshAgentHomes(scope);
  return updated;
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
  await refreshAgentHomes(scope);
};
