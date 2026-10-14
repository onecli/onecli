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
import { missingPermissions } from "../apps/missing-permissions";
import { logger } from "../lib/logger";
import {
  invalidateGatewayCacheForAccount,
  invalidateGatewayCacheForOrg,
} from "../lib/gateway-invalidate";

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
  // Set when the provider refused the refresh token: the dashboard flags the
  // account "Needs reconnect" (cleared by `reconnectConnection`).
  reauthRequiredAt: true,
  // Set on a connection built on another's grant (a shared GitHub App
  // installation): the dashboard names where it comes from.
  sourceConnectionId: true,
} as const;

/**
 * A listed connection plus the requested permissions its grant lacks (the
 * user unticked them on the consent screen). Derived on read from the stored
 * `scopes`, so it covers every existing row and clears itself on a reconnect
 * that grants them. Names and descriptions only: never a credential.
 */
const withMissingPermissions = <
  T extends { provider: string; scopes: string[] },
>(
  connection: T,
) => ({
  ...connection,
  missingPermissions: missingPermissions(
    connection.provider,
    connection.scopes,
  ),
});

export const listConnections = async (scope: ResourceScope) => {
  const rows = await db.appConnection.findMany({
    where: scopeWhere(scope),
    select: CONNECTION_SELECT,
    orderBy: { connectedAt: "desc" },
  });
  return rows.map(withMissingPermissions);
};

export const listConnectionsByProvider = async (
  scope: ResourceScope,
  provider: string,
) => {
  const rows = await db.appConnection.findMany({
    where: { ...scopeWhere(scope), provider },
    select: CONNECTION_SELECT,
    orderBy: { connectedAt: "desc" },
  });
  return rows.map(withMissingPermissions);
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
    /** The connection whose grant this one is built on (shared installs). */
    sourceConnectionId?: string;
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
      sourceConnectionId: options?.sourceConnectionId ?? null,
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
      // New credentials supersede the ones the provider refused. Also right for
      // a bare token persist: it only happens after a successful refresh.
      reauthRequiredAt: null,
      label:
        options?.label || (extractLabel(options?.metadata) ?? existing.label),
      credentials: encryptedCredentials,
      scopes: options?.scopes ?? undefined,
      metadata: metadata as Prisma.InputJsonValue | undefined,
      ...provenanceUpdate,
      // A re-auth replaces a shared connection's borrowed grant with one of its
      // own (its own key, no pin), so it is no longer built on its source.
      ...(options?.metadata ? { sourceConnectionId: null } : {}),
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

/**
 * Move a workspace connection up to the organization, in place: the same row
 * (same id, credentials, agent grants and policy targets) becomes org-scoped,
 * so every workspace in the org sees it and this workspace's agents keep the
 * access they had. Caller must have checked org-admin and flushes the gateway
 * (the route's `withAudit`). A shared GitHub App connection is refused: it is
 * a narrowed copy of an installation the org can already share directly.
 */
export const promoteConnectionToOrganization = async (
  workspaceId: string,
  organizationId: string,
  connectionId: string,
) => {
  const existing = await db.appConnection.findFirst({
    where: {
      id: connectionId,
      workspaceId,
      scope: "workspace",
      workspace: { organizationId },
    },
    select: { id: true, sourceConnectionId: true },
  });
  if (!existing) {
    throw new ServiceError("NOT_FOUND", "Connection not found");
  }
  if (existing.sourceConnectionId) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "A shared connection can't be moved to the organization. Share the original installation instead.",
    );
  }

  const updated = await db.appConnection.update({
    where: { id: existing.id },
    data: { scope: "organization", organizationId, workspaceId: null },
    select: { id: true, provider: true, status: true, label: true },
  });
  await refreshAgentHomes({ organizationId });
  return updated;
};

const scopeKey = (scope: ResourceScope) =>
  scope.organizationId && !scope.workspaceId
    ? `org:${scope.organizationId}`
    : `ws:${scope.workspaceId}`;

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

  // Connections built on this one's grant (shared GitHub App installations,
  // possibly in other workspaces) go with it via the FK cascade. Collect their
  // scopes first so those agents and gateway caches refresh too, once per
  // scope. The caller's own scope is flushed by its audit wrapper.
  const derived = await db.appConnection.findMany({
    where: { sourceConnectionId: connection.id },
    select: { scope: true, workspaceId: true, organizationId: true },
  });
  const derivedScopes = new Map<string, ResourceScope>();
  for (const d of derived) {
    const derivedScope: ResourceScope =
      d.scope === "organization" && d.organizationId
        ? { organizationId: d.organizationId }
        : { workspaceId: d.workspaceId ?? undefined };
    if (!derivedScope.workspaceId && !derivedScope.organizationId) continue;
    derivedScopes.set(scopeKey(derivedScope), derivedScope);
  }
  derivedScopes.delete(scopeKey(scope));

  await db.appConnection.delete({
    where: { id: connection.id },
  });
  await refreshAgentHomes(scope);
  for (const derivedScope of derivedScopes.values()) {
    await refreshAgentHomes(derivedScope);
    if (derivedScope.workspaceId)
      invalidateGatewayCacheForAccount(derivedScope.workspaceId);
    else if (derivedScope.organizationId)
      invalidateGatewayCacheForOrg(derivedScope.organizationId);
  }
};
