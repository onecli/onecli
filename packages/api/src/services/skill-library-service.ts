import { db, Prisma } from "@onecli/db";
import { ServiceError } from "./errors";
import { logger } from "../lib/logger";
import { getCrypto } from "../providers";
import {
  GitHubInstallationError,
  githubApp,
  githubInstallsAreProven,
  listGitHubInstallationRepos,
  mintGitHubInstallationToken,
} from "../apps/github-app";
import { resolveOrgAppCredentials } from "../apps/resolve-org-credentials";
import {
  SKILLS_ONLY_UNAVAILABLE,
  readLibraryGrant,
} from "./skill-library-grant";
import {
  GitHubReadError,
  fetchBranchHead,
  fetchRepoTree,
  fetchSkillFiles,
  listSkills,
  skillAt,
  skillFolderTree,
  treeOfSkills,
  type FetchedSkillFile,
  type RepoSkill,
  type RepoTree,
  type SkippedFile,
} from "../apps/github-skill-repo";
import {
  decryptGitHubAppCredentials,
  metaString,
  orgConnectionsWhere,
} from "./github-app-share-service";
import {
  LIBRARY_MANIFEST_BUDGET_BYTES,
  LIBRARY_SYNC_BUDGET_BYTES,
  bumpHomeForAgent,
  bumpHomeForAgents,
  libraryManifestBytes,
  librarySyncBytes,
} from "./home-sync-service";

const log = logger.child({ component: "skill-library" });

/**
 * The skill library: an org connects ONE GitHub repo of skills; OneCLI only
 * reads it. Browsing is live from GitHub (cached per commit for a minute);
 * only skills an agent actually uses are stored, with their files at the
 * commit they were fetched from. A refresh pass keeps those in step with the
 * branch head.
 *
 * A stored skill follows its FOLDER in the repo (`path`). When that folder
 * is gone and exactly one valid folder elsewhere claims its name, the skill
 * was moved and follows it; a name two folders claim is never guessed (both
 * are refused as duplicates).
 */

/** How often the poll sweep re-checks a source's branch head. */
const LIBRARY_REFRESH_SECONDS = 300;
/** Library skills one agent may hold (on or off). */
export const MAX_LIBRARY_SKILLS_PER_AGENT = 50;
/** Sources one sweep claims; each is refreshed in turn. */
const REFRESH_BATCH = 5;

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/;

/** Why a stored skill couldn't move forward. Stored as the bare reason: the
 * dashboard says it kept the last version. */
const REMOVED_UPSTREAM = "Removed from the repo";

export interface SkillSourceView {
  id: string;
  repo: string;
  branch: string;
  headSha: string | null;
  lastSyncedAt: Date | null;
  lastError: string | null;
  /** GitHub refused the library's installation: reconnect, don't retry. */
  accessLost: boolean;
  appConnectionId: string | null;
  account: string | null;
  accountType: string | null;
  installationId: string;
}

/** What replacing or disconnecting the library would take away: the stored
 * skills and how many agents hold at least one of them. */
export interface LibraryUsage {
  skillNames: string[];
  agentCount: number;
}

export interface LibrarySkillView {
  id: string;
  name: string;
  description: string;
  plugin: string | null;
  path: string;
  commitSha: string;
  /** Agents that hold it (on or off). */
  agentCount: number;
  /** Per-agent views only: this agent's switch. */
  enabled?: boolean;
  fileCount: number;
  skipped: SkippedFile[];
  lastError: string | null;
  updatedAt: Date;
  /** Compared to the repo's latest known commit: "current" (same commit,
   * no error), "behind" (the repo moved on), or "error" (last fetch failed,
   * the agent keeps the previous version). */
  status: "current" | "behind" | "error";
  /** The repo commit the status was judged against (the source head). */
  repoSha: string | null;
  /** When OneCLI last asked GitHub for the branch head. */
  checkedAt: Date | null;
}

export interface DiscoverResult {
  repo: string;
  commitSha: string;
  truncated: boolean;
  skills: (RepoSkill & {
    /** Already on THIS agent (when asked for one). */
    added: boolean;
  })[];
}

/** Thrown when replacing the repo or branch would drop skills agents use and
 * the caller didn't confirm it. */
export class LibraryReplaceConflict extends ServiceError {
  readonly usage: LibraryUsage;
  constructor(usage: LibraryUsage) {
    super(
      "CONFLICT",
      `Switching the library removes ${usage.skillNames.length} library skill${usage.skillNames.length === 1 ? "" : "s"} from ${usage.agentCount} agent${usage.agentCount === 1 ? "" : "s"}. Confirm to continue.`,
    );
    this.name = "LibraryReplaceConflict";
    this.usage = usage;
  }
}

// ── GitHub access (server-side only) ───────────────────────────────────────

/** The library's own GitHub App credential, copied at connect time. */
interface LibraryCredential {
  app_id: string;
  installation_id: string;
  private_key: string;
}

/** Thrown when GitHub refuses the library's installation (removed, or no
 * longer reaching the repo): only a reconnect fixes it. */
class LibraryAccessLost extends ServiceError {
  constructor(message: string) {
    super("UNPROCESSABLE", message);
    this.name = "LibraryAccessLost";
  }
}

/** Library tokens only ever read repository contents. */
const READ_CONTENTS = { contents: "read" } as const;

/**
 * A read-only installation token, narrowed to `repo` when given. GitHub
 * refusing the installation (removed, or no longer reaching the repo) is
 * "access lost"; a 5xx, a rate limit, or no answer at all is transient and
 * said so, never a reason to reconnect.
 */
const mintFor = async (
  cred: LibraryCredential,
  repo?: string,
): Promise<string> => {
  try {
    const { token } = await mintGitHubInstallationToken({
      appId: cred.app_id,
      privateKey: cred.private_key,
      installationId: cred.installation_id,
      ...(repo && { repositories: [repo] }),
      permissions: READ_CONTENTS,
    });
    return token;
  } catch (err) {
    log.warn({ err, repo }, "skill library: token mint refused");
    const lost =
      err instanceof GitHubInstallationError &&
      err.status < 500 &&
      err.status !== 429;
    if (!lost) {
      throw new ServiceError(
        "UNPROCESSABLE",
        "Couldn't reach GitHub. Try again in a minute.",
      );
    }
    throw new LibraryAccessLost(
      repo
        ? `GitHub access lost for ${repo}. The GitHub App may have been removed or no longer reaches this repo. Reconnect the library.`
        : "GitHub refused access to this installation. Install GitHub for skills again.",
    );
  }
};

/**
 * Copy a GitHub App installation's credential from one of the org's
 * connections (fenced to the org). A shared connection holds no signing key
 * of its own, so its original's is used. After this the library does not
 * depend on the connection: removing it leaves the library working.
 */
const copyCredentialFrom = async (
  organizationId: string,
  appConnectionId: string,
): Promise<{
  cred: LibraryCredential;
  account: string | null;
  accountType: string | null;
}> => {
  // Only the org's OWN GitHub connections can back the library: a
  // workspace's install is that workspace's to give, not the org library's.
  const row = await db.appConnection.findFirst({
    where: {
      ...orgConnectionsWhere(organizationId),
      id: appConnectionId,
      scope: "organization",
    },
    select: { credentials: true, metadata: true, sourceConnectionId: true },
  });
  if (!row) {
    throw new ServiceError("NOT_FOUND", "GitHub connection not found");
  }
  const keyRow = row.sourceConnectionId
    ? await db.appConnection.findFirst({
        where: {
          ...orgConnectionsWhere(organizationId),
          id: row.sourceConnectionId,
        },
        select: { credentials: true },
      })
    : row;
  const creds = await decryptGitHubAppCredentials(keyRow?.credentials ?? null);
  if (!creds) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "This GitHub connection can't read repositories",
    );
  }
  return {
    cred: {
      app_id: creds.app_id,
      installation_id: creds.installation_id,
      private_key: creds.private_key,
    },
    account: metaString(row.metadata, "username"),
    accountType: metaString(row.metadata, "accountType"),
  };
};

const readCredential = async (
  encrypted: string,
): Promise<LibraryCredential> => {
  try {
    const parsed = JSON.parse(await getCrypto().decrypt(encrypted)) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "app_id" in parsed &&
      typeof parsed.app_id === "string" &&
      "installation_id" in parsed &&
      typeof parsed.installation_id === "string" &&
      "private_key" in parsed &&
      typeof parsed.private_key === "string"
    ) {
      return {
        app_id: parsed.app_id,
        installation_id: parsed.installation_id,
        private_key: parsed.private_key,
      };
    }
  } catch (err) {
    log.warn({ err }, "skill library: credential decrypt failed");
  }
  throw new ServiceError(
    "UNPROCESSABLE",
    "Couldn't read the library's GitHub credential. Reconnect the library.",
  );
};

/** A read-only token narrowed to the source's one repo, from the library's
 * OWN credential (never a connection row). */
const tokenFor = async (source: {
  credentials: string;
  repo: string;
}): Promise<string> =>
  mintFor(await readCredential(source.credentials), source.repo);

const readError = (err: unknown, repo: string): ServiceError => {
  if (err instanceof ServiceError) return err;
  if (err instanceof GitHubReadError) {
    if (err.retryAfterSeconds !== null) {
      const minutes = Math.max(1, Math.ceil(err.retryAfterSeconds / 60));
      return new ServiceError(
        "RATE_LIMITED",
        `GitHub's rate limit was reached. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      );
    }
    return new ServiceError(
      "UNPROCESSABLE",
      err.status === 404
        ? `Couldn't find ${repo} or its branch on GitHub`
        : `GitHub refused the request: ${err.message}`,
    );
  }
  return new ServiceError(
    "UNPROCESSABLE",
    "Couldn't read the repo from GitHub",
  );
};

/**
 * The repo's skills at one commit. `tree` holds only the entries under the
 * listed skills' folders (all a fetch of one of them needs). `partial`: the
 * listing may not show every skill (GitHub truncated the tree, or the repo
 * has more than LIBRARY_MAX_LISTED_SKILLS), so a skill missing from it must
 * be looked up on its own before it is called removed.
 */
interface Listing {
  tree: RepoTree;
  skills: RepoSkill[];
  partial: boolean;
}

// Listing cache, per (source, commit): short-lived and process-local by
// design (a miss only costs GitHub round trips). Bounded by the tree entries
// it holds, not just by count, so no repo shape can make it large; a
// listing is read once however many requests ask for it at the same time.
const LISTING_TTL_MS = 60_000;
const LISTING_CACHE_MAX_ENTRIES = 100_000;
const listingCache = new Map<string, { at: number; listing: Listing }>();
const listingsInFlight = new Map<string, Promise<Listing>>();

const cachedEntries = () => {
  let total = 0;
  for (const { listing } of listingCache.values()) {
    total += listing.tree.entries.length;
  }
  return total;
};

const cacheListing = (key: string, listing: Listing) => {
  const now = Date.now();
  for (const [k, v] of listingCache) {
    if (now - v.at >= LISTING_TTL_MS) listingCache.delete(k);
  }
  const size = listing.tree.entries.length;
  if (size > LISTING_CACHE_MAX_ENTRIES) return;
  while (cachedEntries() + size > LISTING_CACHE_MAX_ENTRIES) {
    const oldest = listingCache.keys().next().value;
    if (oldest === undefined) break;
    listingCache.delete(oldest);
  }
  listingCache.set(key, { at: now, listing });
};

/** Read the repo's skills at `head`, keeping only what a fetch needs. */
const readListing = async (
  token: string,
  repo: string,
  head: string,
): Promise<Listing> => {
  const tree = await fetchRepoTree(token, repo, head);
  const { skills, capped } = await listSkills(token, repo, tree);
  return {
    tree: treeOfSkills(
      tree,
      skills.map((s) => s.path),
    ),
    skills,
    partial: tree.truncated || capped,
  };
};

/** The repo's skills at one commit (cached per source and commit). */
const listingAt = async (
  token: string,
  source: { id: string; repo: string },
  head: string,
): Promise<Listing> => {
  const key = `${source.id}:${head}`;
  const hit = listingCache.get(key);
  if (hit && Date.now() - hit.at < LISTING_TTL_MS) return hit.listing;
  const pending = listingsInFlight.get(key);
  if (pending) return pending;
  const read = readListing(token, source.repo, head)
    .then((listing) => {
      cacheListing(key, listing);
      return listing;
    })
    .finally(() => listingsInFlight.delete(key));
  listingsInFlight.set(key, read);
  return read;
};

/** The repo's skills at the branch head, read once. */
const listRepoSkills = async (
  token: string,
  source: { id: string; repo: string; branch: string },
) =>
  listingAt(
    token,
    source,
    await fetchBranchHead(token, source.repo, source.branch),
  );

// ── The source (one per org) ────────────────────────────────────────────────

const sourceSelect = {
  id: true,
  repo: true,
  branch: true,
  headSha: true,
  lastSyncedAt: true,
  lastError: true,
  accessLost: true,
  appConnectionId: true,
  account: true,
  accountType: true,
  installationId: true,
} as const;

/** The skills stored for a source that some agent holds, and how many
 * agents hold at least one. */
const usageOf = async (sourceId: string): Promise<LibraryUsage> => {
  const [skills, agents] = await Promise.all([
    db.librarySkill.findMany({
      where: { sourceId, attachments: { some: {} } },
      select: { name: true },
      orderBy: { name: "asc" },
    }),
    db.agentLibrarySkill.findMany({
      where: { librarySkill: { sourceId } },
      select: { agentId: true },
      distinct: ["agentId"],
    }),
  ]);
  return { skillNames: skills.map((s) => s.name), agentCount: agents.length };
};

export const getSkillSource = async (
  organizationId: string,
): Promise<{
  source: SkillSourceView | null;
  usage: LibraryUsage | null;
  skillsOnlyInstall: boolean;
}> => {
  const [source, app] = await Promise.all([
    db.skillSource.findUnique({
      where: { organizationId },
      select: sourceSelect,
    }),
    resolveOrgAppCredentials(organizationId, githubApp),
  ]);
  return {
    source,
    usage: source ? await usageOf(source.id) : null,
    // Whether "Install GitHub for skills only" can be offered here.
    skillsOnlyInstall: githubInstallsAreProven(app?.values.appId),
  };
};

/**
 * Where the library's GitHub access comes from:
 * - `appConnectionId`: one of the org's OWN GitHub connections (copied);
 * - `grant`: a fresh "Install GitHub for skills only" (no connection exists;
 *   see `skill-library-grant`), for THIS org and user;
 * - neither: the library's current access (changing the repo or branch).
 */
export type LibraryAccessInput =
  | { appConnectionId: string; grant?: undefined }
  | { grant: string; appConnectionId?: undefined }
  | { appConnectionId?: undefined; grant?: undefined };

interface ResolvedAccess {
  cred: LibraryCredential;
  account: string | null;
  accountType: string | null;
  appConnectionId: string | null;
}

/** A skills-only grant's installation, with the org's GitHub App key
 * (resolved here, never carried by the grant). */
const credentialFromGrant = async (
  organizationId: string,
  userId: string | null,
  raw: string,
): Promise<ResolvedAccess> => {
  if (!userId) {
    throw new ServiceError("FORBIDDEN", "Sign in to install GitHub for skills");
  }
  const grant = readLibraryGrant(raw, { organizationId, userId });
  const app = await resolveOrgAppCredentials(organizationId, githubApp);
  const appId = app?.values.appId;
  const privateKey = app?.values.privateKey;
  if (!appId || !privateKey) {
    throw new ServiceError("UNPROCESSABLE", "GitHub App is not configured");
  }
  // Belt: a grant names an installation by id alone, so it is honored only
  // where that id was proven (the install refuses to start one otherwise,
  // but the app config may have changed since).
  if (!githubInstallsAreProven(appId)) {
    throw new ServiceError("FORBIDDEN", SKILLS_ONLY_UNAVAILABLE);
  }
  return {
    cred: {
      app_id: appId,
      installation_id: grant.installationId,
      private_key: privateKey,
    },
    account: grant.account,
    accountType: grant.accountType,
    appConnectionId: null,
  };
};

/** The library's current access, to change its repo without a new install. */
const currentCredential = async (
  organizationId: string,
): Promise<ResolvedAccess> => {
  const source = await db.skillSource.findUnique({
    where: { organizationId },
    select: {
      credentials: true,
      account: true,
      accountType: true,
      appConnectionId: true,
    },
  });
  if (!source) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Pick a GitHub account, or install GitHub for skills",
    );
  }
  return {
    cred: await readCredential(source.credentials),
    account: source.account,
    accountType: source.accountType,
    appConnectionId: source.appConnectionId,
  };
};

const resolveAccess = async (
  organizationId: string,
  userId: string | null,
  input: LibraryAccessInput,
): Promise<ResolvedAccess> => {
  if (input.appConnectionId) {
    return {
      ...(await copyCredentialFrom(organizationId, input.appConnectionId)),
      appConnectionId: input.appConnectionId,
    };
  }
  if (input.grant) {
    return credentialFromGrant(organizationId, userId, input.grant);
  }
  return currentCredential(organizationId);
};

/** A GitHub account the org connected AT THE ORG LEVEL: the only kind the
 * library may reuse (a workspace's install is that workspace's to give). */
export interface LibraryGitHubAccount {
  appConnectionId: string;
  installationId: string;
  account: string | null;
  accountType: string | null;
}

export const listLibraryGitHubAccounts = async (
  organizationId: string,
): Promise<LibraryGitHubAccount[]> => {
  const rows = await db.appConnection.findMany({
    where: { ...orgConnectionsWhere(organizationId), scope: "organization" },
    select: { id: true, metadata: true },
    orderBy: { connectedAt: "asc" },
  });
  const seen = new Set<string>();
  const out: LibraryGitHubAccount[] = [];
  for (const row of rows) {
    const installationId = metaString(row.metadata, "installationId");
    if (!installationId || seen.has(installationId)) continue;
    seen.add(installationId);
    out.push({
      appConnectionId: row.id,
      installationId,
      account: metaString(row.metadata, "username"),
      accountType: metaString(row.metadata, "accountType"),
    });
  }
  return out;
};

/** The installation an access reaches, for the dialog's "Add it on GitHub"
 * link (which GitHub settings page manages its repos). */
export interface LibraryInstallation {
  installationId: string;
  account: string | null;
  accountType: string | null;
}

/** The repos the library could read with the given access: the connect
 * dialog's repo menu (an org connection, a fresh skills-only grant, or the
 * library's own access), and the installation they come from. */
export const listLibraryAccessRepos = async (
  organizationId: string,
  userId: string | null,
  input: LibraryAccessInput,
): Promise<{
  repos: string[];
  truncated: boolean;
  installation: LibraryInstallation;
}> => {
  const { cred, account, accountType } = await resolveAccess(
    organizationId,
    userId,
    input,
  );
  const token = await mintFor(cred);
  const installation = {
    installationId: cred.installation_id,
    account,
    accountType,
  };
  try {
    return { ...(await listGitHubInstallationRepos(token)), installation };
  } catch (err) {
    log.warn({ err }, "skill library: repo listing failed");
    throw new ServiceError(
      "UNPROCESSABLE",
      "Couldn't list this installation's repos from GitHub. Try again.",
    );
  }
};

/** Serializes every change to an org's source (connect, switch, disconnect):
 * an advisory lock, since a first connect has no row to lock yet. */
const lockOrgSource = (tx: Prisma.TransactionClient, organizationId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`skill-source:${organizationId}`}))`;

/** The agents holding any of a source's skills: the only homes a change to
 * the source can reach. */
const holdersOfSource = async (
  tx: Prisma.TransactionClient,
  sourceId: string,
): Promise<string[]> =>
  (
    await tx.agentLibrarySkill.findMany({
      where: { librarySkill: { sourceId } },
      select: { agentId: true },
      distinct: ["agentId"],
    })
  ).map((h) => h.agentId);

/**
 * Connect, or replace the org's repo. The access is copied into the library
 * itself (from an org connection, a skills-only grant, or kept from before),
 * then the repo and branch are verified readable before saving.
 *
 * Changing only the access keeps the source and its skills. Changing the
 * repo or branch REPLACES the source: a new row (new id), so any fetch still
 * in flight for the old repo writes against a source that no longer exists
 * and lands nothing. That drops every stored skill and every agent's
 * attachment, so it needs `replace: true` when agents hold any; without it
 * the call is refused with the impact (`LibraryReplaceConflict`).
 */
export const connectSkillSource = async (
  organizationId: string,
  input: LibraryAccessInput & {
    repo: string;
    branch?: string;
    replace?: boolean;
  },
  creator: { userId: string | null; email: string | null },
): Promise<SkillSourceView> => {
  const repo = input.repo.trim();
  const branch = (input.branch ?? "main").trim() || "main";
  if (
    !REPO_PATTERN.test(repo) ||
    repo.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "Repository must look like owner/name",
    );
  }
  if (!BRANCH_PATTERN.test(branch) || branch.includes("..")) {
    throw new ServiceError("UNPROCESSABLE", "Invalid branch name");
  }
  const access = await resolveAccess(organizationId, creator.userId, input);

  // Verify the branch is readable with this access before saving anything.
  let head: string;
  try {
    const token = await mintFor(access.cred, repo);
    head = await fetchBranchHead(token, repo, branch);
  } catch (err) {
    throw readError(err, repo);
  }
  const credentials = await getCrypto().encrypt(JSON.stringify(access.cred));
  const owned = {
    credentials,
    installationId: access.cred.installation_id,
    account: access.account,
    accountType: access.accountType,
    appConnectionId: access.appConnectionId,
    repo,
    branch,
    headSha: head,
    lastError: null,
    accessLost: false,
  };

  type Outcome =
    | { kind: "saved"; row: SkillSourceView; holders: string[] }
    | { kind: "conflict"; sourceId: string };
  const outcome = await db.$transaction(async (tx): Promise<Outcome> => {
    // One change to the org's source at a time, so two can't both decide on
    // a stale picture of it.
    await lockOrgSource(tx, organizationId);
    const existing = await tx.skillSource.findUnique({
      where: { organizationId },
      select: { id: true, repo: true, branch: true },
    });
    if (existing && existing.repo === repo && existing.branch === branch) {
      const row = await tx.skillSource.update({
        where: { id: existing.id },
        data: owned,
        select: sourceSelect,
      });
      return { kind: "saved", row, holders: [] };
    }
    const holders = existing ? await holdersOfSource(tx, existing.id) : [];
    if (existing) {
      if (holders.length > 0 && !input.replace) {
        return { kind: "conflict", sourceId: existing.id };
      }
      await tx.skillSource.delete({ where: { id: existing.id } });
    }
    const row = await tx.skillSource.create({
      data: {
        organizationId,
        ...owned,
        // A new source holds no skills yet: in step with its head by
        // definition. (Changing only the access keeps both clocks: its
        // stored skills are as synced as they were, and read "behind" when
        // the head moved.)
        lastCheckedAt: new Date(),
        lastSyncedAt: new Date(),
        createdByUserId: creator.userId,
        createdByEmail: creator.email,
      },
      select: sourceSelect,
    });
    return { kind: "saved", row, holders };
  });
  if (outcome.kind === "conflict") {
    throw new LibraryReplaceConflict(await usageOf(outcome.sourceId));
  }
  await bumpHomeForAgents(outcome.holders);
  return outcome.row;
};

/** Disconnect: every library skill leaves the agents holding it. Answers
 * what was connected, for the audit. */
export const disconnectSkillSource = async (
  organizationId: string,
): Promise<{ repo: string; branch: string }> => {
  const removed = await db.$transaction(async (tx) => {
    await lockOrgSource(tx, organizationId);
    const source = await tx.skillSource.findUnique({
      where: { organizationId },
      select: { id: true, repo: true, branch: true },
    });
    if (!source) return null;
    const holders = await holdersOfSource(tx, source.id);
    await tx.skillSource.delete({ where: { id: source.id } });
    return { repo: source.repo, branch: source.branch, holders };
  });
  if (!removed) {
    throw new ServiceError("NOT_FOUND", "No skill library is connected");
  }
  await bumpHomeForAgents(removed.holders);
  return { repo: removed.repo, branch: removed.branch };
};

const requireSource = async (organizationId: string) => {
  const source = await db.skillSource.findUnique({
    where: { organizationId },
    select: {
      id: true,
      repo: true,
      branch: true,
      credentials: true,
    },
  });
  if (!source) {
    throw new ServiceError("NOT_FOUND", "No skill library is connected");
  }
  return source;
};

// ── Discover (live) ──────────────────────────────────────────────────────────

/** The live repo listing; with an `agentId` (already fenced to the caller's
 * workspace) each skill is marked with whether that agent holds it. */
export const discoverLibrarySkills = async (
  organizationId: string,
  agentId?: string,
): Promise<DiscoverResult> => {
  const source = await requireSource(organizationId);
  let listing: Listing;
  try {
    listing = await listRepoSkills(await tokenFor(source), source);
  } catch (err) {
    throw readError(err, source.repo);
  }
  const held = agentId
    ? new Set(
        (
          await db.librarySkill.findMany({
            where: { sourceId: source.id, attachments: { some: { agentId } } },
            select: { name: true },
          })
        ).map((s) => s.name),
      )
    : new Set<string>();
  return {
    repo: source.repo,
    commitSha: listing.tree.commitSha,
    truncated: listing.partial,
    // By name, the way an add resolves it (a held skill whose folder moved
    // still reads as added).
    skills: listing.skills.map((skill) => ({
      ...skill,
      added: !skill.problem && held.has(skill.name),
    })),
  };
};

const librarySelect = {
  id: true,
  name: true,
  description: true,
  plugin: true,
  path: true,
  commitSha: true,
  skipped: true,
  lastError: true,
  updatedAt: true,
  source: { select: { headSha: true, lastCheckedAt: true } },
  _count: { select: { files: true, attachments: true } },
} as const;

type LibraryRow = Prisma.LibrarySkillGetPayload<{
  select: typeof librarySelect;
}>;

const parseSkipped = (value: Prisma.JsonValue | null): SkippedFile[] =>
  Array.isArray(value)
    ? value.flatMap((v) =>
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        typeof v.path === "string" &&
        typeof v.reason === "string"
          ? [{ path: v.path, reason: v.reason }]
          : [],
      )
    : [];

const toLibraryView = (row: LibraryRow): LibrarySkillView => ({
  id: row.id,
  name: row.name,
  description: row.description,
  plugin: row.plugin,
  path: row.path,
  commitSha: row.commitSha,
  agentCount: row._count.attachments,
  fileCount: row._count.files,
  skipped: parseSkipped(row.skipped),
  lastError: row.lastError,
  updatedAt: row.updatedAt,
  status: row.lastError
    ? "error"
    : row.source.headSha && row.source.headSha !== row.commitSha
      ? "behind"
      : "current",
  repoSha: row.source.headSha,
  checkedAt: row.source.lastCheckedAt,
});

/** One agent's library skills, each with its switch (on or off). The caller
 * fences the agent to its workspace first (`requireHostedAgentInWorkspace`). */
export const listLibrarySkillsForAgent = async (
  organizationId: string,
  agentId: string,
): Promise<LibrarySkillView[]> => {
  const rows = await db.librarySkill.findMany({
    where: {
      source: { organizationId },
      attachments: { some: { agentId } },
    },
    orderBy: { name: "asc" },
    select: {
      ...librarySelect,
      attachments: { where: { agentId }, select: { enabled: true } },
    },
  });
  return rows.map((row) => ({
    ...toLibraryView(row),
    enabled: row.attachments[0]?.enabled ?? false,
  }));
};

// ── Fetch / store one skill ─────────────────────────────────────────────────

/** A skill folder's files at `tree`, complete even from a truncated repo
 * listing. Null when the folder is gone (removed upstream). */
const fetchFolder = async (
  token: string,
  source: { repo: string },
  tree: RepoTree,
  skill: RepoSkill,
): Promise<{ files: FetchedSkillFile[]; skipped: SkippedFile[] } | null> => {
  const folder = await skillFolderTree(token, source.repo, tree, skill.path);
  if (!folder) return null;
  const fetched = await fetchSkillFiles(
    token,
    source.repo,
    folder,
    skill.path,
    skill.name,
  );
  if (!fetched.files.some((f) => f.path === "SKILL.md")) {
    throw new ServiceError("UNPROCESSABLE", "SKILL.md couldn't be read");
  }
  return fetched;
};

/** What a fetched folder costs an agent's home sync. */
const costOf = (name: string, files: FetchedSkillFile[]) => ({
  syncBytes: librarySyncBytes(name, files),
  manifestBytes: libraryManifestBytes(
    name,
    files.map((f) => f.path),
  ),
});
type SyncCost = ReturnType<typeof costOf>;

/** Whether `cost` on top of `used` stays inside an agent's library budgets. */
const withinBudget = (used: SyncCost, cost: SyncCost) =>
  used.syncBytes + cost.syncBytes <= LIBRARY_SYNC_BUDGET_BYTES &&
  used.manifestBytes + cost.manifestBytes <= LIBRARY_MANIFEST_BUDGET_BYTES;

/** What each holder of `librarySkillId` spends on its OTHER library skills:
 * one grouped sum over the stored costs, no file rows read. */
const holdersUsage = async (
  tx: Prisma.TransactionClient,
  librarySkillId: string,
): Promise<SyncCost[]> => {
  const rows = await tx.$queryRaw<
    { sync_bytes: bigint | null; manifest_bytes: bigint | null }[]
  >`
    SELECT SUM(ls."sync_bytes") AS sync_bytes,
           SUM(ls."manifest_bytes") AS manifest_bytes
    FROM "agent_library_skills" holder
    LEFT JOIN "agent_library_skills" other
      ON other."agent_id" = holder."agent_id"
     AND other."library_skill_id" <> ${librarySkillId}
    LEFT JOIN "library_skills" ls ON ls."id" = other."library_skill_id"
    WHERE holder."library_skill_id" = ${librarySkillId}
    GROUP BY holder."agent_id"`;
  return rows.map((r) => ({
    syncBytes: Number(r.sync_bytes ?? 0),
    manifestBytes: Number(r.manifest_bytes ?? 0),
  }));
};

/** The skipped-file list as stored JSON. */
const skippedJson = (skipped: SkippedFile[]): Prisma.InputJsonArray =>
  skipped.map((s) => ({ path: s.path, reason: s.reason }));

const TOO_BIG_FOR_AGENTS =
  "The new version is too big to deliver to the agents using it";

/**
 * Write a fetched folder over an existing stored skill, but only if that
 * skill (and so its source) still exists and the new files keep every holder
 * inside its sync budgets. Answers whether the files changed (a new commit
 * that left this folder alone changes nothing an agent sees). A source
 * replaced or disconnected mid-fetch leaves no row to write: nothing lands.
 */
const writeStored = async (
  rowId: string,
  skill: RepoSkill,
  commitSha: string,
  fetched: { files: FetchedSkillFile[]; skipped: SkippedFile[] },
): Promise<boolean> =>
  db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "library_skills" WHERE "id" = ${rowId} FOR UPDATE`;
    if (locked.length === 0) return false;
    const cost = costOf(skill.name, fetched.files);
    const holders = await holdersUsage(tx, rowId);
    if (holders.some((used) => !withinBudget(used, cost))) {
      await tx.librarySkill.update({
        where: { id: rowId },
        data: { lastError: TOO_BIG_FOR_AGENTS },
      });
      return false;
    }
    const before = await tx.librarySkillFile.findMany({
      where: { librarySkillId: rowId },
      select: { path: true, content: true },
    });
    await tx.librarySkill.update({
      where: { id: rowId },
      data: {
        path: skill.path,
        description: skill.description,
        plugin: skill.plugin,
        commitSha,
        skipped: skippedJson(fetched.skipped),
        ...cost,
        lastError: null,
      },
    });
    if (sameFiles(before, fetched.files)) return false;
    await tx.librarySkillFile.deleteMany({ where: { librarySkillId: rowId } });
    await tx.librarySkillFile.createMany({
      data: fetched.files.map((f) => ({
        librarySkillId: rowId,
        path: f.path,
        content: f.content,
      })),
    });
    return true;
  });

/** Whether two file sets are the same paths with the same contents. */
const sameFiles = (a: FetchedSkillFile[], b: FetchedSkillFile[]) => {
  if (a.length !== b.length) return false;
  const byPath = new Map(a.map((f) => [f.path, f.content]));
  return b.every((f) => byPath.get(f.path) === f.content);
};

/** Record why a stored skill couldn't move forward (it keeps its last good
 * files, so nothing an agent holds changes). */
const recordProblem = async (rowId: string, problem: string) => {
  await db.librarySkill.updateMany({
    where: { id: rowId },
    data: { lastError: problem },
  });
};

/** Where a stored skill is in `listing`, and the tree its folder is read
 * from: its folder, or (that folder gone) the one valid folder that now
 * claims its name, where it was moved to. A partial listing may just not
 * show the folder: it is read on its own (walking the commit's tree)
 * before anything is called removed. */
const locateStored = async (
  token: string,
  source: { repo: string },
  listing: Listing,
  row: { path: string; name: string },
): Promise<{ skill: RepoSkill; tree: RepoTree } | null> => {
  const listed = listing.skills.find((s) => s.path === row.path);
  if (listed) return { skill: listed, tree: listing.tree };
  if (listing.partial) {
    // Marked truncated: the walk reads the folder from the commit itself.
    const walk = { ...listing.tree, truncated: true };
    const found = await skillAt(token, source.repo, walk, row.path);
    if (found) return { skill: found, tree: walk };
  }
  const moved = listing.skills.filter((s) => s.name === row.name && !s.problem);
  const only = moved.length === 1 ? moved[0] : undefined;
  return only ? { skill: only, tree: listing.tree } : null;
};

/** Bring one stored skill to `listing`. Answers whether its files changed
 * (the only thing an agent's home projects). */
const syncStored = async (
  token: string,
  source: { repo: string },
  listing: Listing,
  row: {
    id: string;
    name: string;
    path: string;
    commitSha: string;
    lastError: string | null;
  },
): Promise<boolean> => {
  if (row.commitSha === listing.tree.commitSha) {
    // The stored files ARE this commit's: any recorded problem is stale.
    if (row.lastError !== null) await clearProblem(row.id);
    return false;
  }
  try {
    const located = await locateStored(token, source, listing, row);
    if (!located) {
      await recordProblem(row.id, REMOVED_UPSTREAM);
      return false;
    }
    const { skill, tree } = located;
    if (skill.problem) {
      await recordProblem(row.id, skill.problem);
      return false;
    }
    const fetched = await fetchFolder(token, source, tree, skill);
    if (fetched) {
      return await writeStored(row.id, skill, listing.tree.commitSha, fetched);
    }
    await recordProblem(row.id, REMOVED_UPSTREAM);
  } catch (err) {
    await recordProblem(row.id, readError(err, source.repo).message);
  }
  return false;
};

const clearProblem = async (rowId: string) => {
  await db.librarySkill.updateMany({
    where: { id: rowId },
    data: { lastError: null },
  });
};

// ── Attach / detach / switch ────────────────────────────────────────────────

/** The agent, fenced to the caller's workspace, and hosted (only hosted
 * agents have a home to project skills into). A foreign agent is NOT_FOUND. */
export const requireHostedAgentInWorkspace = async (
  workspaceId: string,
  agentId: string,
) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: { id: true, kind: true },
  });
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");
  if (agent.kind !== "hosted") {
    throw new ServiceError(
      "UNPROCESSABLE",
      "Only hosted agents can hold skills",
    );
  }
};

const LIBRARY_FULL = `This agent already has ${MAX_LIBRARY_SKILLS_PER_AGENT} library skills. Remove one first`;
const AGENT_BUDGET_FULL =
  "This agent's library skills are too big to deliver together. Remove one first";

/**
 * Add a repo skill to an agent (idempotent: adding it again switches it back
 * on). The skill is stored once per org, from its folder at the branch head,
 * the first time any agent adds it.
 */
export const attachLibrarySkill = async (args: {
  organizationId: string;
  workspaceId: string;
  agentId: string;
  name: string;
  userId: string | null;
}): Promise<LibrarySkillView> => {
  await requireHostedAgentInWorkspace(args.workspaceId, args.agentId);
  const source = await requireSource(args.organizationId);

  // Fetch outside any transaction (GitHub may be slow): the folder, unless
  // it is already stored.
  const stored = await db.librarySkill.findUnique({
    where: { sourceId_name: { sourceId: source.id, name: args.name } },
    select: { id: true },
  });
  let fresh: {
    skill: RepoSkill;
    commitSha: string;
    fetched: { files: FetchedSkillFile[]; skipped: SkippedFile[] };
  } | null = null;
  if (!stored) {
    try {
      const token = await tokenFor(source);
      const listing = await listRepoSkills(token, source);
      const skill = listing.skills.find((s) => s.name === args.name);
      if (!skill) {
        throw new ServiceError(
          "NOT_FOUND",
          `No skill named "${args.name}" in the repo`,
        );
      }
      if (skill.problem) throw new ServiceError("UNPROCESSABLE", skill.problem);
      const fetched = await fetchFolder(token, source, listing.tree, skill);
      if (!fetched) {
        throw new ServiceError(
          "NOT_FOUND",
          `No skill named "${args.name}" in the repo`,
        );
      }
      fresh = { skill, commitSha: listing.tree.commitSha, fetched };
    } catch (err) {
      throw readError(err, source.repo);
    }
  }

  // Decide and write in one transaction. The locks: the source (a source
  // replaced since the read above lands nothing), the agent (two adds to
  // one agent can't both pass the caps), and the stored skill (a removal of
  // its last holder can't delete it under this add).
  const attachOnce = () =>
    db.$transaction(async (tx) => {
      const live = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "skill_sources" WHERE "id" = ${source.id} FOR SHARE`;
      if (live.length === 0) {
        throw new ServiceError(
          "CONFLICT",
          "The skill library changed while adding. Try again",
        );
      }
      // NO KEY UPDATE: serializes two adds to one agent without blocking the
      // inserts that only reference it (turns, memories, sandboxes).
      await tx.$queryRaw`SELECT 1 FROM "agents" WHERE "id" = ${args.agentId} FOR NO KEY UPDATE`;
      await tx.$queryRaw`
      SELECT 1 FROM "library_skills"
      WHERE "source_id" = ${source.id} AND "name" = ${args.name} FOR SHARE`;

      const costSelect = {
        id: true,
        syncBytes: true,
        manifestBytes: true,
      } as const;
      const row =
        (await tx.librarySkill.findUnique({
          where: { sourceId_name: { sourceId: source.id, name: args.name } },
          select: costSelect,
        })) ??
        (fresh
          ? await tx.librarySkill.create({
              data: {
                sourceId: source.id,
                name: fresh.skill.name,
                path: fresh.skill.path,
                description: fresh.skill.description,
                plugin: fresh.skill.plugin,
                commitSha: fresh.commitSha,
                skipped: skippedJson(fresh.fetched.skipped),
                ...costOf(fresh.skill.name, fresh.fetched.files),
                files: { create: fresh.fetched.files },
              },
              select: costSelect,
            })
          : null);
      if (!row) {
        throw new ServiceError(
          "CONFLICT",
          "The skill was removed while adding. Try again",
        );
      }

      const held = await tx.agentLibrarySkill.findMany({
        where: { agentId: args.agentId },
        select: {
          librarySkillId: true,
          librarySkill: { select: { syncBytes: true, manifestBytes: true } },
        },
      });
      const already = held.some((h) => h.librarySkillId === row.id);
      if (!already) {
        if (held.length >= MAX_LIBRARY_SKILLS_PER_AGENT) {
          throw new ServiceError("UNPROCESSABLE", LIBRARY_FULL);
        }
        const used = held.reduce(
          (sum, h) => ({
            syncBytes: sum.syncBytes + h.librarySkill.syncBytes,
            manifestBytes: sum.manifestBytes + h.librarySkill.manifestBytes,
          }),
          { syncBytes: 0, manifestBytes: 0 },
        );
        if (!withinBudget(used, row)) {
          throw new ServiceError("UNPROCESSABLE", AGENT_BUDGET_FULL);
        }
      }
      await tx.agentLibrarySkill.upsert({
        where: {
          agentId_librarySkillId: {
            agentId: args.agentId,
            librarySkillId: row.id,
          },
        },
        create: {
          agentId: args.agentId,
          librarySkillId: row.id,
          createdByUserId: args.userId,
        },
        // Adding again means "I want it": switch it back on.
        update: { enabled: true },
      });
      return row.id;
    });
  let librarySkillId: string;
  try {
    librarySkillId = await attachOnce();
  } catch (err) {
    // Two first adds of one skill (to different agents): the other created
    // the stored row first. Once more, and this add holds that row.
    if (
      !(err instanceof Prisma.PrismaClientKnownRequestError) ||
      err.code !== "P2002"
    ) {
      throw err;
    }
    librarySkillId = await attachOnce();
  }

  await bumpHomeForAgent(args.agentId);
  const view = await db.librarySkill.findUniqueOrThrow({
    where: { id: librarySkillId },
    select: librarySelect,
  });
  return { ...toLibraryView(view), enabled: true };
};

/** The org's stored skill named `name`, if this agent holds it. */
const heldByAgent = (organizationId: string, agentId: string, name: string) =>
  db.librarySkill.findFirst({
    where: {
      name,
      source: { organizationId },
      attachments: { some: { agentId } },
    },
    select: { id: true },
  });

/**
 * Delete a stored skill if no agent holds it. Its row lock comes first (the
 * order an add takes), and the count after it sees any add that committed
 * meanwhile: a concurrent add either lands before this or sees the skill
 * gone (and says try again).
 */
const deleteIfUnheld = async (tx: Prisma.TransactionClient, id: string) => {
  await tx.$queryRaw`SELECT 1 FROM "library_skills" WHERE "id" = ${id} FOR UPDATE`;
  const holders = await tx.agentLibrarySkill.count({
    where: { librarySkillId: id },
  });
  if (holders === 0) await tx.librarySkill.deleteMany({ where: { id } });
};

export const detachLibrarySkill = async (args: {
  organizationId: string;
  workspaceId: string;
  agentId: string;
  name: string;
}): Promise<void> => {
  await requireHostedAgentInWorkspace(args.workspaceId, args.agentId);
  const row = await heldByAgent(args.organizationId, args.agentId, args.name);
  if (!row) throw new ServiceError("NOT_FOUND", "Skill not on this agent");
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "library_skills" WHERE "id" = ${row.id} FOR UPDATE`;
    await tx.agentLibrarySkill.deleteMany({
      where: { agentId: args.agentId, librarySkillId: row.id },
    });
    // The last holder gone: the stored copy goes too.
    await deleteIfUnheld(tx, row.id);
  });
  await bumpHomeForAgent(args.agentId);
};

/** The agent's on/off switch for a library skill it holds. Off keeps it on
 * the agent's page but out of its projection and tools. */
export const setAgentLibrarySkillEnabled = async (args: {
  organizationId: string;
  workspaceId: string;
  agentId: string;
  name: string;
  enabled: boolean;
}): Promise<LibrarySkillView> => {
  await requireHostedAgentInWorkspace(args.workspaceId, args.agentId);
  const row = await heldByAgent(args.organizationId, args.agentId, args.name);
  if (!row) throw new ServiceError("NOT_FOUND", "Skill not on this agent");
  await db.agentLibrarySkill.updateMany({
    where: { agentId: args.agentId, librarySkillId: row.id },
    data: { enabled: args.enabled },
  });
  await bumpHomeForAgent(args.agentId);
  // A removal racing this switch leaves nothing to show: say so, not a 500.
  const view = await db.librarySkill.findUnique({
    where: { id: row.id },
    select: librarySelect,
  });
  if (!view) throw new ServiceError("NOT_FOUND", "Skill not on this agent");
  return { ...toLibraryView(view), enabled: args.enabled };
};

// ── Refresh (the poll sweep) and Re-sync ────────────────────────────────────

/** What a stored skill's refresh needs to know about it. */
const storedSelect = {
  id: true,
  name: true,
  path: true,
  commitSha: true,
  lastError: true,
} as const;

/** Wake the agents holding any of these stored skills. */
const bumpHolders = async (librarySkillIds: string[]) => {
  if (librarySkillIds.length === 0) return;
  const holders = await db.agentLibrarySkill.findMany({
    where: { librarySkillId: { in: librarySkillIds } },
    select: { agentId: true },
    distinct: ["agentId"],
  });
  await bumpHomeForAgents(holders.map((h) => h.agentId));
};

/** Bring one source's stored skills to the branch head (read once for the
 * whole pass). A skill that can't move (removed upstream, now invalid, too
 * big, GitHub error) keeps its last good files and records why. Only the
 * agents holding a skill whose files changed are woken. */
export const refreshSkillSource = async (sourceId: string): Promise<void> => {
  const source = await db.skillSource.findUnique({
    where: { id: sourceId },
    select: {
      id: true,
      organizationId: true,
      credentials: true,
      repo: true,
      branch: true,
    },
  });
  if (!source) return;
  // A deleted agent takes its attachments with it but can't run a removal:
  // stored skills nobody holds any more go here, before anything is fetched.
  const unheld = await db.librarySkill.findMany({
    where: { sourceId: source.id, attachments: { none: {} } },
    select: { id: true },
  });
  for (const { id } of unheld) {
    await db.$transaction((tx) => deleteIfUnheld(tx, id));
  }
  try {
    const token = await tokenFor(source);
    const head = await fetchBranchHead(token, source.repo, source.branch);
    // Skills already at the head hold exactly its files: any recorded
    // problem (say, a branch rolled back to their commit) is stale.
    await db.librarySkill.updateMany({
      where: { sourceId: source.id, commitSha: head, lastError: { not: null } },
      data: { lastError: null },
    });
    const stored = await db.librarySkill.findMany({
      where: { sourceId: source.id, commitSha: { not: head } },
      select: storedSelect,
    });
    const changed: string[] = [];
    if (stored.length > 0) {
      const listing = await listingAt(token, source, head);
      for (const row of stored) {
        if (await syncStored(token, source, listing, row)) changed.push(row.id);
      }
    }
    // updateMany: a source disconnected mid-pass simply isn't there.
    await db.skillSource.updateMany({
      where: { id: source.id },
      data: {
        headSha: head,
        lastSyncedAt: new Date(),
        lastError: null,
        accessLost: false,
      },
    });
    await bumpHolders(changed);
  } catch (err) {
    log.warn({ err, sourceId }, "skill library refresh failed");
    await db.skillSource.updateMany({
      where: { id: source.id },
      data: {
        lastError: readError(err, source.repo).message,
        accessLost: err instanceof LibraryAccessLost,
      },
    });
  }
};

/** Poll-sweep entry: claim sources whose check is due (stamping the clock
 * forward is the lease, so concurrent polls never double-fetch) and refresh
 * each. Best-effort per source. */
export const refreshDueSkillSources = async (): Promise<number> => {
  const due = await db.$queryRaw<{ id: string }[]>`
    UPDATE "skill_sources" SET "last_checked_at" = now()
    WHERE "id" IN (
      SELECT "id" FROM "skill_sources"
      WHERE "last_checked_at" IS NULL
         OR "last_checked_at" < now() - make_interval(secs => ${LIBRARY_REFRESH_SECONDS})
      ORDER BY "last_checked_at" NULLS FIRST
      LIMIT ${REFRESH_BATCH}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id"`;
  for (const { id } of due) {
    await refreshSkillSource(id).catch((err: unknown) =>
      log.error({ err, sourceId: id }, "skill library refresh crashed"),
    );
  }
  return due.length;
};

/** "Re-sync": check the branch head NOW and bring one stored skill to it.
 * Records the head on the source (so siblings honestly read "behind" until
 * the next refresh) and returns the skill's fresh view. A failure keeps the
 * last good files and records why, like the background refresh. The stored
 * skill is shared, so this updates every agent that holds it. */
export const resyncLibrarySkill = async (
  organizationId: string,
  name: string,
): Promise<LibrarySkillView> => {
  const source = await requireSource(organizationId);
  const row = await db.librarySkill.findUnique({
    where: { sourceId_name: { sourceId: source.id, name } },
    select: storedSelect,
  });
  if (!row) throw new ServiceError("NOT_FOUND", "Skill not in use");
  try {
    const token = await tokenFor(source);
    const listing = await listRepoSkills(token, source);
    await db.skillSource.updateMany({
      where: { id: source.id },
      data: {
        headSha: listing.tree.commitSha,
        lastCheckedAt: new Date(),
        lastError: null,
        accessLost: false,
      },
    });
    if (await syncStored(token, source, listing, row)) {
      await bumpHolders([row.id]);
    }
  } catch (err) {
    const message = readError(err, source.repo).message;
    await recordProblem(row.id, message);
    // Lost access is the library's problem, not this skill's: the card says
    // reconnect.
    if (err instanceof LibraryAccessLost) {
      await db.skillSource.updateMany({
        where: { id: source.id },
        data: { lastError: message, accessLost: true },
      });
    }
  }
  const view = await db.librarySkill.findUnique({
    where: { id: row.id },
    select: librarySelect,
  });
  if (!view) throw new ServiceError("NOT_FOUND", "Skill not in use");
  return toLibraryView(view);
};

// ── Agent tools ───────────────────────────────────────────────────────────────
// (The composer reads library files itself in home-sync-service: this module
// imports the bumps from there, so the import must not go the other way.)

/** The library skills an agent has switched ON, for the skill_* tools. */
export const libraryNamesForAgent = async (
  agentId: string,
  organizationId: string,
): Promise<{ name: string; description: string; repo: string }[]> => {
  const rows = await db.librarySkill.findMany({
    where: {
      source: { organizationId },
      attachments: { some: { agentId, enabled: true } },
    },
    select: {
      name: true,
      description: true,
      source: { select: { repo: true } },
    },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => ({
    name: r.name,
    description: r.description,
    repo: r.source.repo,
  }));
};
