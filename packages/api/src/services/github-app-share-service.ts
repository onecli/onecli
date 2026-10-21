import { db, Prisma } from "@onecli/db";
import { getCrypto } from "../providers";
import { ServiceError } from "./errors";
import { scopeOwnership, type ResourceScope } from "./resource-scope";
import { promoteConnectionToOrganization } from "./connection-service";
import { lockGitHubInstallation } from "./github-installation-connect-service";
import { bumpHomeForScope } from "./home-sync-service";
import {
  GitHubInstallationError,
  listGitHubInstallationRepos,
  mintGitHubInstallationToken,
} from "../apps/github-app";
import { logger } from "../lib/logger";
import { userIsOrgAdmin } from "./workspace-access-check";

/**
 * GitHub App installations across a OneCLI organization.
 *
 * GitHub allows ONE installation of an app per GitHub account, so a second
 * workspace can't install it again. The model is simple: an installation is
 * connected ONCE in the org, either in one workspace or at the org level.
 * Sharing it moves that connection up to the org level (same id, key, repos
 * and agent access), and every workspace inherits it and turns it on per
 * agent. There are no copies, so removing a workspace connection never
 * touches another one, and removing the org-level one removes it everywhere.
 *
 * The fence: candidates come only from connections owned by the caller's org.
 * We never ask GitHub which accounts installed the app (on the hosted edition
 * the app is shared by every customer, and that list would be other
 * tenants'). Sharing and repo edits are org-admin acts.
 */

/** Who is asking, and from which scope. */
export interface ShareCaller {
  organizationId: string;
  userId: string;
  target: ResourceScope;
}

export const GITHUB_APP_PROVIDER = "github-app";

/** Upper bound on repos one connection may pin. */
const MAX_SELECTED_REPOS = 500;

interface GitHubAppCredentials {
  type: "github_app";
  installation_id: string;
  app_id: string;
  private_key: string;
  repositories?: string[];
}

export interface SharedInstallation {
  /** The installation's connection (the one sharing moves up). */
  sourceConnectionId: string;
  installationId: string;
  account: string | null;
  accountType: string | null;
  avatarUrl: string | null;
  /** Connections that already reach the caller's scope (its own, or an
   *  org-level one a workspace inherits). */
  connectedHere: number;
}

/** Every connected GitHub App connection of the caller's org, originals and
 * the shared connections built on them. */
export const orgConnectionsWhere = (organizationId: string) => ({
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

/** A string field of a GitHub connection's metadata, or null. */
export const metaString = (meta: Prisma.JsonValue | null, key: string) => {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const value = meta[key];
  return typeof value === "string" ? value : null;
};

export const decryptGitHubAppCredentials = async (
  encrypted: string | null,
): Promise<GitHubAppCredentials | null> => {
  if (!encrypted) return null;
  let plain: string;
  try {
    plain = await getCrypto().decrypt(encrypted);
  } catch (err) {
    // The key service or the local key refused. It may pass (a throttled or
    // briefly unavailable key service) or not (a disabled or rotated key, a
    // damaged value), so say both, and never "can't be shared".
    logger.warn({ err }, "github app share: credential decrypt failed");
    throw new ServiceError(
      "UNPROCESSABLE",
      "Couldn't read this connection's stored credentials. Try again, and if it keeps failing, reconnect the original GitHub connection.",
    );
  }
  try {
    const parsed: unknown = JSON.parse(plain);
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
  } catch {
    logger.warn("github app share: credential parse failed");
  }
  return null;
};

/**
 * Whether a connection already reaches `target` without building another one:
 * a row in the target scope itself, or (for a workspace) an org-level row,
 * which every workspace inherits and switches on per agent.
 */
const reachesScope = (
  row: { scope: string; workspaceId: string | null },
  target: ResourceScope,
) => isInScope(row, target) || row.scope === "organization";

const isInScope = (
  row: { scope: string; workspaceId: string | null },
  target: ResourceScope,
) =>
  target.workspaceId
    ? row.scope === "workspace" && row.workspaceId === target.workspaceId
    : row.scope === "organization";

/**
 * The org's GitHub installations, one entry per installation, each with
 * where its connection lives. Connections made before sharing moved
 * connections up may still be copies; the original represents them.
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
    // The caller's own original wins over an older one elsewhere: the same
    // installation connected here AND in another workspace is "this_scope".
    if (
      !row.sourceConnectionId &&
      isInScope(row, target) &&
      entry.root &&
      !isInScope(entry.root, target)
    ) {
      entry.root = row;
    }
    if (reachesScope(row, target)) entry.connectedHere += 1;
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
      connectedHere,
    });
  }
  return result;
};

/** GitHub's refusal of an installation call, as the caller's error. */
const installationRefusal = (err: unknown) =>
  new ServiceError(
    "UNPROCESSABLE",
    err instanceof GitHubInstallationError && err.status === 404
      ? "This GitHub installation no longer exists. The app was removed or reinstalled on GitHub, so the original connection must be disconnected and connected again."
      : "GitHub refused access to this installation.",
  );

/** A repo pick, de-duplicated, bounded, and inside the installation's grant
 * (GitHub's own spelling kept). Empty or outside = refused, never "all". */
const pickWithinInstallation = (
  wanted: string[],
  granted: string[],
): string[] => {
  const unique = [
    ...new Map(wanted.map((r) => [r.trim().toLowerCase(), r.trim()])).values(),
  ].filter(Boolean);
  if (unique.length === 0) {
    throw new ServiceError("BAD_REQUEST", "Pick at least one repository");
  }
  if (unique.length > MAX_SELECTED_REPOS) {
    throw new ServiceError(
      "BAD_REQUEST",
      `Pick at most ${MAX_SELECTED_REPOS} repositories, or all of them`,
    );
  }
  const grantedByLower = new Map(granted.map((r) => [r.toLowerCase(), r]));
  const outside = unique.filter((r) => !grantedByLower.has(r.toLowerCase()));
  if (outside.length > 0) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `Not covered by this installation: ${outside.slice(0, 5).join(", ")}`,
    );
  }
  return unique.map((r) => grantedByLower.get(r.toLowerCase()) ?? r);
};

/** Every repo an installation grants, read live from GitHub. */
const installationRepos = async (key: GitHubAppCredentials) => {
  try {
    const { token } = await mintGitHubInstallationToken({
      appId: key.app_id,
      privateKey: key.private_key,
      installationId: key.installation_id,
    });
    return await listGitHubInstallationRepos(token);
  } catch (err) {
    logger.warn({ err }, "github app: repo listing");
    throw installationRefusal(err);
  }
};

/**
 * Share an installation connected in a workspace with the whole organization:
 * the connection itself moves up (same id, key, repos, agent access), so every
 * workspace inherits ONE org-level connection instead of holding copies. An
 * installation already at the org level already reaches every workspace.
 */
export const shareInstallationWithOrganization = async (args: {
  caller: ShareCaller;
  sourceConnectionId: string;
}) => {
  const { caller } = args;
  await assertCanShare(caller);
  const shared = await db.$transaction(
    async (tx) => {
      const candidate = await tx.appConnection.findFirst({
        where: {
          ...orgConnectionsWhere(caller.organizationId),
          id: args.sourceConnectionId,
          sourceConnectionId: null,
        },
        select: { metadata: true },
      });
      const installationId = metaString(
        candidate?.metadata ?? null,
        "installationId",
      );
      if (!installationId)
        throw new ServiceError("NOT_FOUND", "Installation not found");
      await lockGitHubInstallation(tx, caller.organizationId, installationId);
      const row = await tx.appConnection.findFirst({
        where: {
          ...orgConnectionsWhere(caller.organizationId),
          id: args.sourceConnectionId,
          sourceConnectionId: null,
          metadata: { path: ["installationId"], equals: installationId },
        },
        select: { id: true, scope: true, workspaceId: true },
      });
      if (!row) throw new ServiceError("NOT_FOUND", "Installation not found");
      if (row.scope === "organization" || !row.workspaceId) {
        throw new ServiceError(
          "CONFLICT",
          "This GitHub account is already shared with every workspace. Turn it on for an agent from the agent's Connections.",
        );
      }
      return promoteConnectionToOrganization(
        row.workspaceId,
        caller.organizationId,
        row.id,
        tx,
      );
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 30_000,
    },
  );
  await bumpHomeForScope({ organizationId: caller.organizationId }).catch(
    (err: unknown) => {
      logger.warn({ err }, "connection change: agent home refresh failed");
    },
  );
  return shared;
};

// ── One connection's repositories: see, refresh, and change ─────────────────

/**
 * A GitHub App connection IN THE CALLER'S SCOPE (fenced at the query: a row
 * of another workspace or org reads as not found), with the signing key it
 * mints with: its own for an original, its source's for a shared one (which
 * holds none). Org admins only, the same rule as sharing.
 */
const loadOwnConnection = async (caller: ShareCaller, connectionId: string) => {
  await assertCanShare(caller);
  const row = await db.appConnection.findFirst({
    where: {
      ...scopeOwnership(caller.target, connectionId),
      provider: GITHUB_APP_PROVIDER,
      status: "connected",
    },
    select: {
      id: true,
      credentials: true,
      metadata: true,
      sourceConnectionId: true,
      updatedAt: true,
    },
  });
  if (!row) throw new ServiceError("NOT_FOUND", "Connection not found");
  const raw = await decryptRawCredentials(row.credentials);
  const keyHolder = row.sourceConnectionId
    ? await db.appConnection.findFirst({
        where: {
          ...orgConnectionsWhere(caller.organizationId),
          id: row.sourceConnectionId,
          sourceConnectionId: null,
        },
        select: { credentials: true },
      })
    : row;
  const key = await decryptGitHubAppCredentials(keyHolder?.credentials ?? null);
  if (
    !raw ||
    !key ||
    raw.installation_id !== key.installation_id ||
    raw.app_id !== key.app_id
  ) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "This GitHub connection's access can't be read. Reconnect it.",
    );
  }
  return { row, raw, key, sourceCredentials: keyHolder?.credentials };
};

/** The stored credential blob as-is (an original's or a shared one's), so an
 * edit rewrites only the pin and the token and keeps every other field. */
const decryptRawCredentials = async (
  encrypted: string | null,
): Promise<Record<string, unknown> | null> => {
  if (!encrypted) return null;
  try {
    const parsed: unknown = JSON.parse(await getCrypto().decrypt(encrypted));
    return parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "type" in parsed &&
      parsed.type === "github_app"
      ? parsed
      : null;
  } catch {
    logger.warn("github app connection: credential read failed");
    return null;
  }
};

/** The connection's display metadata for the repos it reaches (a pin, or
 * the whole installation). */
const reposMetadata = (
  meta: Prisma.JsonValue | null,
  selected: string[] | null,
  live: string[],
): Prisma.InputJsonObject => {
  const granted = new Set(live.map((repo) => repo.toLowerCase()));
  const reachable =
    selected?.filter((repo) => granted.has(repo.toLowerCase())) ?? live;
  return {
    ...(meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {}),
    repositorySelection: selected ? "selected" : "all",
    repos: reachable,
    tags: selected
      ? reachable.map((r) => r.split("/").pop() ?? r)
      : ["All repositories"],
  };
};

export interface ConnectionRepositories {
  /** Every repo the installation grants right now (live from GitHub). */
  available: string[];
  truncated: boolean;
  /** The connection's own pin; null = every repo the installation grants. */
  selected: string[] | null;
}

/**
 * Read GitHub live without changing stored state. Refreshing the persisted
 * resource menu is a separate, audited operation, never a side effect of GET.
 */
export const getConnectionRepositories = async (
  caller: ShareCaller,
  connectionId: string,
): Promise<ConnectionRepositories> => {
  const { raw, key } = await loadOwnConnection(caller, connectionId);
  const live = await installationRepos(key);
  const selected = repositoryPin(raw);
  return { available: live.repos, truncated: live.truncated, selected };
};

const repositoryPin = (raw: Record<string, unknown>): string[] | null => {
  if (raw.repositories === undefined || raw.repositories === null) return null;
  if (
    !Array.isArray(raw.repositories) ||
    raw.repositories.some((repo) => typeof repo !== "string" || !repo.trim())
  ) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "This connection's repository restriction can't be read. Reconnect it.",
    );
  }
  return raw.repositories.filter(
    (repo): repo is string => typeof repo === "string",
  );
};

/** Reject a stale read rather than overwriting a reconnect, edit or key handover. */
const repositoryWriteWhere = (
  caller: ShareCaller,
  loaded: Awaited<ReturnType<typeof loadOwnConnection>>,
) => ({
  ...scopeOwnership(caller.target, loaded.row.id),
  provider: GITHUB_APP_PROVIDER,
  status: "connected",
  credentials: loaded.row.credentials,
  updatedAt: loaded.row.updatedAt,
  sourceConnectionId: loaded.row.sourceConnectionId,
  ...(loaded.row.sourceConnectionId
    ? {
        sourceConnection: {
          is: {
            ...orgConnectionsWhere(caller.organizationId),
            sourceConnectionId: null,
            credentials: loaded.sourceCredentials,
          },
        },
      }
    : {}),
});

const assertRepositoryWrite = (count: number) => {
  if (count !== 1)
    throw new ServiceError(
      "CONFLICT",
      "This connection changed while GitHub was loading. Reopen the repository picker and try again.",
    );
};

export const refreshConnectionRepositories = async (
  caller: ShareCaller,
  connectionId: string,
): Promise<ConnectionRepositories> => {
  const loaded = await loadOwnConnection(caller, connectionId);
  const live = await installationRepos(loaded.key);
  const selected = repositoryPin(loaded.raw);
  const result = await db.appConnection.updateMany({
    where: repositoryWriteWhere(caller, loaded),
    data: {
      metadata: reposMetadata(loaded.row.metadata, selected, live.repos),
    },
  });
  assertRepositoryWrite(result.count);
  return { available: live.repos, truncated: live.truncated, selected };
};

/**
 * Change which repos a connection reaches: a subset of the installation, or
 * every repo (`undefined`). Re-mints for the new set first (GitHub must accept
 * it), then stores the pin the gateway mints every refresh with. The id is
 * unchanged, so agents that use it keep it; an agent narrowed to a repo now
 * outside the pin simply loses that repo (the gateway takes the overlap).
 */
export const setConnectionRepositories = async (args: {
  caller: ShareCaller;
  connectionId: string;
  repositories?: string[];
}): Promise<{ id: string; repositories: string[] | null }> => {
  const loaded = await loadOwnConnection(args.caller, args.connectionId);
  const { row, raw, key } = loaded;
  const live = await installationRepos(key);
  const selected = args.repositories
    ? pickWithinInstallation(args.repositories, live.repos)
    : undefined;

  let minted: Awaited<ReturnType<typeof mintGitHubInstallationToken>>;
  try {
    minted = await mintGitHubInstallationToken({
      appId: key.app_id,
      privateKey: key.private_key,
      installationId: key.installation_id,
      repositories: selected,
    });
  } catch (err) {
    logger.warn({ err }, "github app connection: scoped mint failed");
    throw new ServiceError(
      "UNPROCESSABLE",
      "GitHub refused a token for these repositories",
    );
  }

  // The old pin is replaced (or removed, for "all"), never merged.
  const rest = { ...raw };
  delete rest.repositories;
  const credentials = {
    ...rest,
    access_token: minted.token,
    expires_at: minted.expiresAt,
    ...(selected ? { repositories: selected } : {}),
  };
  const result = await db.appConnection.updateMany({
    where: repositoryWriteWhere(args.caller, loaded),
    data: {
      credentials: await getCrypto().encrypt(JSON.stringify(credentials)),
      metadata: reposMetadata(row.metadata, selected ?? null, live.repos),
    },
  });
  assertRepositoryWrite(result.count);
  return { id: row.id, repositories: selected ?? null };
};
