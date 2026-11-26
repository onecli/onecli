import { db, Prisma } from "@onecli/db";
import { getCrypto } from "../providers";
import { logger } from "../lib/logger";
import {
  createConnection,
  findInstallationConnection,
  promoteConnectionToOrganization,
  reconnectConnection,
} from "./connection-service";
import { bumpHomeForScope } from "./home-sync-service";
import { ServiceError } from "./errors";
import { scopeOwnership, type ResourceScope } from "./resource-scope";

interface ConnectGitHubInstallationInput {
  scope: ResourceScope;
  organizationId: string;
  credentials: Record<string, unknown>;
  options?: Parameters<typeof createConnection>[3];
  reconnectId?: string;
  /** Only after the callback has authorized the actor as an org admin. */
  allowPromotion?: boolean;
  beforeCreate?: () => Promise<void>;
}

type InstallationConnectResult =
  | { status: "updated" }
  | {
      status: "created" | "reconnected";
      connection: { id: string };
      /** True only when this committed callback moved a workspace row up. */
      promoted?: boolean;
    };

const assertIdentity = async (
  encrypted: string | null,
  credentials: Record<string, unknown>,
) => {
  let stored: unknown;
  try {
    stored = encrypted
      ? JSON.parse(await getCrypto().decrypt(encrypted))
      : null;
  } catch {
    // Never expose a decrypted credential or crypto provider error.
  }
  if (
    !stored ||
    typeof stored !== "object" ||
    !("type" in stored) ||
    stored.type !== "github_app" ||
    !("app_id" in stored) ||
    stored.app_id !== credentials.app_id ||
    !("installation_id" in stored) ||
    stored.installation_id !== credentials.installation_id
  ) {
    throw new ServiceError(
      "CONFLICT",
      "Reconnect must use the same GitHub app and installation. Connect a different account separately.",
    );
  }
};

export const lockGitHubInstallation = async (
  tx: Prisma.TransactionClient,
  organizationId: string,
  installationId: string,
): Promise<void> => {
  // JSON tuple avoids ambiguous concatenation. Hash collisions only cause
  // harmless extra serialization, never permit duplicate installations.
  const lockKey = JSON.stringify([organizationId, installationId]);
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
};

/**
 * The GitHub-only OAuth persistence boundary. Installation identity, not a
 * mutable account label, determines the row. Lock before any reads, using
 * READ COMMITTED so a waiter sees the previous callback's committed insert
 * (a Serializable snapshot taken before waiting would require retries).
 * Optimistic reconnect guards still reject repository edits racing the mint.
 * The caller retains ownership proof, browser cookie and authorization gates.
 */
export const connectGitHubInstallation = async (
  input: ConnectGitHubInstallationInput,
): Promise<InstallationConnectResult> => {
  const { scope, organizationId, credentials, options, reconnectId } = input;
  const installationId = credentials.installation_id;
  if (
    credentials.type !== "github_app" ||
    typeof installationId !== "string" ||
    !/^[1-9]\d*$/.test(installationId) ||
    typeof credentials.app_id !== "string" ||
    !/^[1-9]\d*$/.test(credentials.app_id) ||
    typeof credentials.private_key !== "string" ||
    !credentials.private_key.trim() ||
    options?.metadata?.installationId !== installationId ||
    (!scope.workspaceId && scope.organizationId !== organizationId) ||
    (scope.workspaceId && scope.organizationId)
  ) {
    throw new ServiceError("BAD_REQUEST", "Invalid GitHub installation");
  }

  const result = await db.$transaction(
    async (tx): Promise<InstallationConnectResult> => {
      await lockGitHubInstallation(tx, organizationId, installationId);
      if (scope.workspaceId) {
        const workspace = await tx.workspace.findFirst({
          where: { id: scope.workspaceId, organizationId },
          select: { id: true },
        });
        if (!workspace)
          throw new ServiceError("NOT_FOUND", "Workspace not found");
      }

      // Explicit reconnects cannot bypass org-wide dedupe or change identity.
      if (reconnectId) {
        const target = await tx.appConnection.findFirst({
          where: {
            ...scopeOwnership(scope, reconnectId),
            provider: "github-app",
          },
          select: { credentials: true },
        });
        if (!target)
          throw new ServiceError("NOT_FOUND", "Connection not found");
        await assertIdentity(target.credentials, credentials);
      }
      const existing = await findInstallationConnection(
        organizationId,
        installationId,
        tx,
      );
      const sameScope =
        existing &&
        (scope.workspaceId
          ? existing.scope === "workspace" &&
            existing.workspaceId === scope.workspaceId
          : existing.scope === "organization");

      if (existing && !sameScope && scope.workspaceId)
        return { status: "updated" };
      if (existing && reconnectId && existing.id !== reconnectId) {
        throw new ServiceError(
          "CONFLICT",
          "This GitHub installation is already connected. Reconnect its existing connection.",
        );
      }
      const connectionId = existing?.id ?? reconnectId;
      if (connectionId) {
        // Fence the identity read to this org even when promoting from a workspace.
        const target = await tx.appConnection.findFirst({
          where: {
            id: connectionId,
            provider: "github-app",
            OR: [
              { scope: "organization", organizationId },
              { scope: "workspace", workspace: { organizationId } },
            ],
          },
          select: { credentials: true },
        });
        if (!target)
          throw new ServiceError("NOT_FOUND", "Connection not found");
        await assertIdentity(target.credentials, credentials);
        let promoted = false;
        if (existing && !sameScope) {
          if (!input.allowPromotion || !existing.workspaceId) {
            throw new ServiceError(
              "FORBIDDEN",
              "Only an authorized organization callback can promote a connection",
            );
          }
          await promoteConnectionToOrganization(
            existing.workspaceId,
            organizationId,
            existing.id,
            tx,
          );
          promoted = true;
        }
        const connection = await reconnectConnection(
          scope,
          connectionId,
          credentials,
          options,
          tx,
        );
        return {
          status: "reconnected",
          connection,
          ...(promoted ? { promoted: true } : {}),
        };
      }
      await input.beforeCreate?.();
      const connection = await createConnection(
        scope,
        "github-app",
        credentials,
        options,
        tx,
      );
      return { status: "created", connection };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 30_000,
    },
  );
  // Transactional persistence helpers intentionally skip external side effects.
  // Refresh only after commit, including the wider scope after promotion.
  if (result.status !== "updated") {
    await bumpHomeForScope(scope).catch((err: unknown) => {
      logger.warn(
        { err },
        "github installation connect: agent home refresh failed",
      );
    });
  }
  return result;
};
