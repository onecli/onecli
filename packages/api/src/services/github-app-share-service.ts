import { db, Prisma } from "@onecli/db";
import { getCrypto } from "../providers";
import { ServiceError } from "./errors";
import type { ResourceScope } from "./resource-scope";
import { createConnection } from "./connection-service";
import {
  GitHubInstallationError,
  listGitHubInstallationRepos,
  mintGitHubInstallationToken,
} from "../apps/github-app";
import { logger } from "../lib/logger";
import { userIsOrgAdmin } from "./workspace-access-check";

/**
 * Sharing one GitHub App installation across a OneCLI organization.
 *
 * GitHub allows ONE installation of an app per GitHub account, so once anyone
 * in the org has installed it — from a workspace or from the org level — every
 * other workspace (and the org level) hits "Configure" on GitHub instead of a
 * fresh install, and never gets a connection of its own. Here a scope builds a
 * connection on an installation that is already connected somewhere in the SAME
 * OneCLI organization, narrowed to the repos it picks. The gateway mints that
 * connection's tokens for exactly those repos.
 *
 * The fence: candidates come only from connections owned by the caller's org
 * (an org-scoped row of the org, or a row in one of the org's workspaces). We
 * never ask GitHub which accounts installed the app — on the hosted edition the
 * app is shared by every customer, and that list would be other tenants'.
 *
 * Sharing is an org-admin act, at either level. A shared connection is a new
 * row with its own id, and org rules (resource boundaries, blocks) bind to the
 * connection id they name, so a copy made by a member would reach the same
 * repos with none of the org's narrowing. Members connect with the regular
 * install flow; on deployments without roles every member is an admin, so
 * nothing changes there.
 */

/** Who is asking, and where the new connection would land. */
export interface ShareCaller {
  organizationId: string;
  userId: string;
  target: ResourceScope;
}

export const GITHUB_APP_PROVIDER = "github-app";

/** Upper bound on repos one shared connection may pin. */
const MAX_SELECTED_REPOS = 500;

interface GitHubAppCredentials {
  type: "github_app";
  installation_id: string;
  app_id: string;
  private_key: string;
  repositories?: string[];
}

export interface SharedInstallation {
  /** The connection the new one is built on (the installation's original). */
  sourceConnectionId: string;
  installationId: string;
  account: string | null;
  accountType: string | null;
  avatarUrl: string | null;
  /** "all" | "selected" — what the GitHub org owner granted the installation. */
  repositorySelection: string | null;
  /** Where the original connection lives, relative to the caller. */
  origin: "this_scope" | "organization" | "another_workspace";
  /** Connections in the caller's scope already using this installation. */
  connectedHere: number;
}

/** Every connected GitHub App connection of the caller's org, originals and
 * the shared connections built on them. */
const orgConnectionsWhere = (organizationId: string) => ({
  provider: GITHUB_APP_PROVIDER,
  status: "connected",
  OR: [
    { scope: "organization", organizationId },
    { scope: "workspace", workspace: { organizationId } },
  ],
});

/** Refuse anyone below org admin. The org-level routes already gate on the
 * admin role; the workspace routes rely on this. */
const assertCanShare = async (caller: ShareCaller) => {
  if (!(await userIsOrgAdmin(caller.userId, caller.organizationId))) {
    throw new ServiceError(
      "FORBIDDEN",
      "Only organization admins can share a GitHub installation",
    );
  }
};

const metaString = (meta: Prisma.JsonValue | null, key: string) => {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const value = meta[key];
  return typeof value === "string" ? value : null;
};

const decryptGitHubAppCredentials = async (
  encrypted: string | null,
): Promise<GitHubAppCredentials | null> => {
  if (!encrypted) return null;
  try {
    const parsed: unknown = JSON.parse(await getCrypto().decrypt(encrypted));
    if (
      parsed &&
      typeof parsed === "object" &&
      "type" in parsed &&
      parsed.type === "github_app" &&
      "installation_id" in parsed &&
      typeof parsed.installation_id === "string" &&
      "app_id" in parsed &&
      typeof parsed.app_id === "string" &&
      "private_key" in parsed &&
      typeof parsed.private_key === "string"
    ) {
      const repositories =
        "repositories" in parsed && Array.isArray(parsed.repositories)
          ? parsed.repositories.filter(
              (r): r is string => typeof r === "string",
            )
          : undefined;
      return {
        type: "github_app",
        installation_id: parsed.installation_id,
        app_id: parsed.app_id,
        private_key: parsed.private_key,
        ...(repositories ? { repositories } : {}),
      };
    }
  } catch (err) {
    logger.warn({ err }, "github app share: credential decrypt failed");
  }
  return null;
};

const isInScope = (
  row: { scope: string; workspaceId: string | null },
  target: ResourceScope,
) =>
  target.workspaceId
    ? row.scope === "workspace" && row.workspaceId === target.workspaceId
    : row.scope === "organization";

/**
 * Installations this caller may build on, one entry per installation.
 * The original (non-derived, oldest) connection represents each one.
 */
export const listSharedInstallations = async (
  caller: ShareCaller,
): Promise<SharedInstallation[]> => {
  await assertCanShare(caller);
  const { target } = caller;
  const rows = await db.appConnection.findMany({
    where: orgConnectionsWhere(caller.organizationId),
    select: {
      id: true,
      scope: true,
      workspaceId: true,
      metadata: true,
      sourceConnectionId: true,
    },
    orderBy: { connectedAt: "asc" },
  });

  const byInstallation = new Map<
    string,
    { root: (typeof rows)[number] | null; connectedHere: number }
  >();
  for (const row of rows) {
    const installationId = metaString(row.metadata, "installationId");
    if (!installationId) continue;
    const entry = byInstallation.get(installationId) ?? {
      root: null,
      connectedHere: 0,
    };
    if (!row.sourceConnectionId && !entry.root) entry.root = row;
    if (isInScope(row, target)) entry.connectedHere += 1;
    byInstallation.set(installationId, entry);
  }

  const result: SharedInstallation[] = [];
  for (const [installationId, { root, connectedHere }] of byInstallation) {
    // Only an original connection can be a source: a derived one holds a
    // narrowed grant, and its own source already represents the installation.
    if (!root) continue;
    result.push({
      sourceConnectionId: root.id,
      installationId,
      account: metaString(root.metadata, "username"),
      accountType: metaString(root.metadata, "accountType"),
      avatarUrl: metaString(root.metadata, "avatarUrl"),
      repositorySelection: metaString(root.metadata, "repositorySelection"),
      origin: isInScope(root, target)
        ? "this_scope"
        : root.scope === "organization"
          ? "organization"
          : "another_workspace",
      connectedHere,
    });
  }
  return result;
};

/** The source connection, fenced to the caller's org and to originals (a
 * shared connection holds a narrowed grant, so it is never a source), with
 * its credentials. */
const loadSource = async (caller: ShareCaller, connectionId: string) => {
  await assertCanShare(caller);
  const row = await db.appConnection.findFirst({
    where: {
      ...orgConnectionsWhere(caller.organizationId),
      id: connectionId,
      sourceConnectionId: null,
    },
    select: {
      id: true,
      credentials: true,
      metadata: true,
      scopes: true,
      appConfigId: true,
    },
  });
  if (!row) throw new ServiceError("NOT_FOUND", "Installation not found");
  const creds = await decryptGitHubAppCredentials(row.credentials);
  if (!creds) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "This GitHub App connection can't be shared",
    );
  }
  return { row, creds };
};

/** GitHub's refusal of an installation call, as the caller's error. */
const installationRefusal = (err: unknown) =>
  new ServiceError(
    "UNPROCESSABLE",
    err instanceof GitHubInstallationError && err.status === 404
      ? "This GitHub installation no longer exists. The app was removed or reinstalled on GitHub, so the original connection must be disconnected and connected again."
      : "GitHub refused access to this installation.",
  );

/** Every repo the installation grants: the menu a scope picks from. */
export const listInstallationRepos = async (
  caller: ShareCaller,
  sourceConnectionId: string,
): Promise<{ repos: string[]; truncated: boolean }> => {
  const { creds } = await loadSource(caller, sourceConnectionId);
  try {
    const { token } = await mintGitHubInstallationToken({
      appId: creds.app_id,
      privateKey: creds.private_key,
      installationId: creds.installation_id,
    });
    return await listGitHubInstallationRepos(token);
  } catch (err) {
    logger.warn({ err, sourceConnectionId }, "github app share: repo listing");
    throw installationRefusal(err);
  }
};

/**
 * Create a connection in `target` built on an installation already connected
 * in the org. `repositories` undefined = everything the installation grants
 * (now and later); otherwise exactly that subset, which must be non-empty and
 * inside the installation's grant.
 */
export const createSharedConnection = async (args: {
  caller: ShareCaller;
  sourceConnectionId: string;
  repositories?: string[];
}) => {
  const { caller } = args;
  const { row, creds } = await loadSource(caller, args.sourceConnectionId);

  let selected: string[] | undefined;
  if (args.repositories) {
    const unique = [...new Set(args.repositories.map((r) => r.trim()))].filter(
      Boolean,
    );
    if (unique.length === 0) {
      throw new ServiceError("BAD_REQUEST", "Pick at least one repository");
    }
    if (unique.length > MAX_SELECTED_REPOS) {
      throw new ServiceError(
        "BAD_REQUEST",
        `Pick at most ${MAX_SELECTED_REPOS} repositories, or all of them`,
      );
    }
    const { repos: granted } = await listInstallationRepos(
      caller,
      args.sourceConnectionId,
    );
    const grantedByLower = new Map(granted.map((r) => [r.toLowerCase(), r]));
    const outside = unique.filter((r) => !grantedByLower.has(r.toLowerCase()));
    if (outside.length > 0) {
      throw new ServiceError(
        "UNPROCESSABLE",
        `Not covered by this installation: ${outside.slice(0, 5).join(", ")}`,
      );
    }
    selected = unique.map((r) => grantedByLower.get(r.toLowerCase()) ?? r);
  }

  let minted: Awaited<ReturnType<typeof mintGitHubInstallationToken>>;
  try {
    minted = await mintGitHubInstallationToken({
      appId: creds.app_id,
      privateKey: creds.private_key,
      installationId: creds.installation_id,
      repositories: selected,
    });
  } catch (err) {
    logger.warn({ err }, "github app share: scoped mint failed");
    throw new ServiceError(
      "UNPROCESSABLE",
      "GitHub refused a token for these repositories",
    );
  }

  const sourceMeta =
    row.metadata &&
    typeof row.metadata === "object" &&
    !Array.isArray(row.metadata)
      ? row.metadata
      : {};
  const metadata: Record<string, unknown> = {
    ...sourceMeta,
    ...(selected
      ? {
          repositorySelection: "selected",
          repos: selected,
          tags: selected.map((r) => r.split("/").pop() ?? r),
        }
      : {}),
  };

  const created = await createConnection(
    caller.target,
    GITHUB_APP_PROVIDER,
    {
      type: "github_app",
      installation_id: creds.installation_id,
      app_id: creds.app_id,
      // No private_key: a shared connection borrows its source's signing key
      // at mint time (the gateway's `source_github_app_key`), so the key lives
      // in exactly one row and removing the source cuts this one off.
      access_token: minted.token,
      expires_at: minted.expiresAt,
      // The gateway mints every refresh for exactly these repos.
      ...(selected ? { repositories: selected } : {}),
    },
    {
      scopes: Object.entries(minted.permissions).map(([k, v]) => `${k}:${v}`),
      metadata,
      appConfigId: row.appConfigId ?? undefined,
      sourceConnectionId: row.id,
    },
  );
  return { ...created, sourceConnectionId: row.id, repositories: selected };
};
