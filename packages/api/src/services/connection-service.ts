import { db, Prisma } from "@onecli/db";
import { createPrivateKey } from "node:crypto";
import { invalidateGatewayCacheForOrg } from "../lib/gateway-invalidate";
import { getCrypto } from "../providers";
import { ServiceError } from "./errors";
import type { ResourceScope } from "./resource-scope";
import { scopeWhere, scopeCreate, scopeOwnership } from "./resource-scope";
import {
  BOUND_HOST_METADATA_KEY,
  deriveBoundHost,
  extractLabel,
  reconnectLabel,
} from "../lib/connection-display";
import { bumpHomeForScope } from "./home-sync-service";
import { missingPermissions } from "../apps/missing-permissions";
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

/**
 * Where a GitHub App installation is already connected in an organization
 * (its org-level row, or a row in one of its workspaces), so a connect never
 * makes a second connection of it: one account, one connection.
 */
export const findInstallationConnection = async (
  organizationId: string,
  installationId: unknown,
  executor: Prisma.TransactionClient = db,
) => {
  if (typeof installationId !== "string" || !installationId) return null;
  return executor.appConnection.findFirst({
    where: {
      provider: "github-app",
      status: "connected",
      metadata: { path: ["installationId"], equals: installationId },
      OR: [
        { scope: "organization", organizationId },
        { scope: "workspace", workspace: { organizationId } },
      ],
    },
    orderBy: [{ scope: "asc" }, { connectedAt: "asc" }],
    select: { id: true, scope: true, workspaceId: true },
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
  executor: Prisma.TransactionClient = db,
) => {
  const encryptedCredentials = await getCrypto().encrypt(
    JSON.stringify(credentials),
  );

  const created = await executor.appConnection.create({
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
  if (executor === db) await refreshAgentHomes(scope);
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
  executor: Prisma.TransactionClient = db,
) => {
  const existing = await executor.appConnection.findFirst({
    where: scopeOwnership(scope, connectionId),
    select: {
      id: true,
      label: true,
      provider: true,
      metadata: true,
      credentials: true,
      updatedAt: true,
    },
  });

  if (!existing) {
    throw new ServiceError("NOT_FOUND", "Connection not found");
  }

  let reconnectMetadata = options?.metadata;
  let reconnectScopes = options?.scopes;
  if (existing.provider === "github-app") {
    const previous = await readGitHubCredentials(existing.credentials);
    if (
      options?.metadata &&
      (previous.app_id !== credentials.app_id ||
        previous.installation_id !== credentials.installation_id)
    ) {
      throw new ServiceError(
        "CONFLICT",
        "Reconnect must use the same GitHub App installation",
      );
    }
    // Historical null means unrestricted, just like an absent pin.
    if (previous.repositories !== undefined && previous.repositories !== null) {
      const repositories = previous.repositories;
      if (
        !Array.isArray(repositories) ||
        repositories.length === 0 ||
        !repositories.every(
          (repo): repo is string => typeof repo === "string" && repo.length > 0,
        )
      ) {
        throw new ServiceError(
          "UNPROCESSABLE",
          "Invalid GitHub repository pin",
        );
      }
      const { app_id, installation_id, private_key } = credentials;
      if (
        typeof app_id !== "string" ||
        !app_id ||
        typeof installation_id !== "string" ||
        !installation_id ||
        typeof private_key !== "string" ||
        !private_key ||
        credentials.type !== "github_app"
      ) {
        throw new ServiceError("UNPROCESSABLE", "Invalid GitHub credentials");
      }
      const { mintGitHubInstallationToken } =
        await import("../apps/github-app");
      const minted = await mintGitHubInstallationToken({
        appId: app_id,
        privateKey: private_key,
        installationId: installation_id,
        repositories,
      });
      credentials = {
        ...credentials,
        repositories,
        access_token: minted.token,
        expires_at: minted.expiresAt,
      };
      reconnectScopes = Object.entries(minted.permissions).map(
        ([key, value]) => `${key}:${value}`,
      );
      reconnectMetadata = {
        ...(options?.metadata ??
          (existing.metadata &&
          typeof existing.metadata === "object" &&
          !Array.isArray(existing.metadata)
            ? existing.metadata
            : {})),
        repositorySelection: "selected",
        repos: repositories,
        tags: repositories.map((repo) => repo.split("/").pop() ?? repo),
        permissions: minted.permissions,
      };
    }
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
  const metadata = reconnectMetadata
    ? withBoundHost(existing.provider, credentials, reconnectMetadata)
    : undefined;

  const updated = await executor.appConnection
    .update({
      where: {
        ...scopeOwnership(scope, existing.id),
        updatedAt: existing.updatedAt,
        credentials: existing.credentials,
      },
      data: {
        status: "connected",
        // New credentials supersede the ones the provider refused. Also right for
        // a bare token persist: it only happens after a successful refresh.
        reauthRequiredAt: null,
        // An explicit label wins; otherwise `reconnectLabel` keeps a user's
        // rename and lets a provider-derived name follow the account.
        label: options?.label || reconnectLabel(existing, options?.metadata),
        credentials: encryptedCredentials,
        scopes: reconnectScopes ?? undefined,
        metadata: metadata as Prisma.InputJsonValue | undefined,
        ...provenanceUpdate,
        // Re-auth gives a shared connection its own key, retaining its repo pin.
        ...(options?.metadata ? { sourceConnectionId: null } : {}),
      },
      select: { id: true, provider: true, status: true, label: true },
    })
    .catch((error: unknown) => {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2025"
      ) {
        throw new ServiceError(
          "CONFLICT",
          "This connection changed while reconnecting. Try again.",
        );
      }
      throw error;
    });
  // A re-auth can move the bound host (a different org); a bare token
  // persist carries no metadata and changes nothing the agent reads.
  if (options?.metadata && executor === db) await refreshAgentHomes(scope);
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
  executor: Prisma.TransactionClient = db,
) => {
  const existing = await executor.appConnection.findFirst({
    where: {
      id: connectionId,
      workspaceId,
      scope: "workspace",
      workspace: { organizationId },
    },
    select: {
      id: true,
      sourceConnectionId: true,
      metadata: true,
      updatedAt: true,
      provider: true,
    },
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
  // One GitHub account, one connection per org: an installation the org
  // level already has is not moved up a second time.
  const meta = existing.metadata;
  const installationId =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? meta.installationId
      : undefined;
  const atOrg =
    existing.provider === "github-app"
      ? await findInstallationConnection(
          organizationId,
          installationId,
          executor,
        )
      : null;
  if (atOrg && atOrg.scope === "organization" && atOrg.id !== existing.id) {
    throw new ServiceError(
      "CONFLICT",
      "This GitHub account is already connected for the whole organization.",
    );
  }

  const updated = await executor.appConnection.update({
    where: {
      id: existing.id,
      workspaceId,
      scope: "workspace",
      sourceConnectionId: null,
      updatedAt: existing.updatedAt,
      workspace: { organizationId },
    },
    data: { scope: "organization", organizationId, workspaceId: null },
    select: { id: true, provider: true, status: true, label: true },
  });
  if (executor === db) await refreshAgentHomes({ organizationId });
  return updated;
};

export const deleteConnection = async (
  scope: ResourceScope,
  connectionId: string,
) => {
  const affectedOrg = await db.$transaction(
    async (tx) => {
      // Block new FK borrowers until the source is deleted, not dedupe locks.
      if (scope.organizationId) {
        await tx.$queryRaw`SELECT id FROM app_connections WHERE id = ${connectionId} AND scope = 'organization' AND organization_id = ${scope.organizationId} FOR UPDATE`;
      } else if (scope.workspaceId) {
        await tx.$queryRaw`SELECT id FROM app_connections WHERE id = ${connectionId} AND scope = 'workspace' AND workspace_id = ${scope.workspaceId} FOR UPDATE`;
      }
      const connection = await tx.appConnection.findFirst({
        where: scopeOwnership(scope, connectionId),
        include: { workspace: { select: { organizationId: true } } },
      });
      if (!connection)
        throw new ServiceError("NOT_FOUND", "Connection not found");
      const organizationId = await detachCopies(tx, connection);
      await tx.appConnection.delete({ where: { id: connection.id } });
      return organizationId;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
  if (affectedOrg) invalidateGatewayCacheForOrg(affectedOrg);
  await refreshAgentHomes(scope);
};

const readGitHubCredentials = async (
  encrypted: string | null,
): Promise<Record<string, unknown>> => {
  try {
    const parsed: unknown = encrypted
      ? JSON.parse(await getCrypto().decrypt(encrypted))
      : null;
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "type" in parsed &&
      parsed.type === "github_app"
    ) {
      return Object.fromEntries(Object.entries(parsed));
    }
  } catch {
    // Credential parser/decryption errors must never reach the caller.
  }
  throw new ServiceError(
    "UNPROCESSABLE",
    "Invalid GitHub connection credentials",
  );
};

const validSigningKey = async (key: string): Promise<boolean> => {
  try {
    const { normalizePem } = await import("../apps/github-app");
    return createPrivateKey(normalizePem(key)).asymmetricKeyType === "rsa";
  } catch {
    return false;
  }
};

/**
 * Hand the source's signing key to its legacy copies before deleting it.
 * Each copy retains its own repository pin and token, and the transaction
 * rolls back rather than unlinking a malformed or foreign-tenant copy.
 */
const detachCopies = async (
  tx: Prisma.TransactionClient,
  source: Prisma.AppConnectionGetPayload<{
    include: { workspace: { select: { organizationId: true } } };
  }>,
) => {
  const copies = await tx.appConnection.findMany({
    where: { sourceConnectionId: source.id },
    include: { workspace: { select: { organizationId: true } } },
    orderBy: { id: "asc" },
  });
  if (copies.length === 0) return;
  const refuse = () =>
    new ServiceError(
      "UNPROCESSABLE",
      "Cannot safely detach shared GitHub connections",
    );
  const organizationId =
    source.scope === "organization"
      ? source.organizationId
      : source.workspace?.organizationId;
  if (
    source.provider !== "github-app" ||
    source.sourceConnectionId ||
    !organizationId
  )
    throw refuse();
  const original = await readGitHubCredentials(source.credentials);
  if (
    typeof original.private_key !== "string" ||
    !original.private_key.trim() ||
    typeof original.app_id !== "string" ||
    !original.app_id ||
    typeof original.installation_id !== "string" ||
    !original.installation_id
  )
    throw refuse();
  if (!(await validSigningKey(original.private_key))) throw refuse();
  for (const copy of copies) {
    const copyOrg =
      copy.scope === "organization"
        ? copy.organizationId
        : copy.workspace?.organizationId;
    if (copy.provider !== source.provider || copyOrg !== organizationId)
      throw refuse();
    const own = await readGitHubCredentials(copy.credentials);
    if (
      own.repositories !== undefined &&
      own.repositories !== null &&
      (!Array.isArray(own.repositories) ||
        own.repositories.length === 0 ||
        !own.repositories.every(
          (repo) => typeof repo === "string" && repo.trim().length > 0,
        ))
    )
      throw refuse();
    if (
      typeof own.private_key === "string" &&
      !(await validSigningKey(own.private_key))
    )
      throw refuse();
    if (
      own.app_id !== original.app_id ||
      own.installation_id !== original.installation_id ||
      ("private_key" in own &&
        (typeof own.private_key !== "string" || !own.private_key.trim()))
    )
      throw refuse();
    await tx.appConnection.update({
      where: {
        id: copy.id,
        sourceConnectionId: source.id,
        credentials: copy.credentials,
        updatedAt: copy.updatedAt,
      },
      data: {
        sourceConnectionId: null,
        credentials: await getCrypto().encrypt(
          JSON.stringify({
            ...own,
            private_key: original.private_key,
          }),
        ),
      },
    });
  }
  return organizationId;
};
