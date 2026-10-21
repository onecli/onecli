import {
  ApiError,
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
} from "./client";

/**
 * The skill library client: the org's connected Git
 * repo of skills. Types hand-mirrored from `skill-library-service.ts`, dates
 * as ISO strings (the house convention).
 */

export interface SkillSource {
  id: string;
  repo: string;
  branch: string;
  headSha: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  /** The library can no longer read its repo (the GitHub App was removed
   * or lost the repo): only a reconnect fixes it. */
  accessLost: boolean;
  /** The connection the credential was copied from (null once it is gone;
   * the library keeps working on its own copy). */
  appConnectionId: string | null;
  account: string | null;
  /** "Organization" or "User": which GitHub page manages the install. */
  accountType: string | null;
  installationId: string;
}

/** What switching the repo or disconnecting would take away. */
export interface LibraryUsage {
  skillNames: string[];
  agentCount: number;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

/** A library skill that is in use (stored in OneCLI). */
export interface LibrarySkill {
  id: string;
  name: string;
  description: string;
  plugin: string | null;
  path: string;
  commitSha: string;
  /** Agents that hold it (on or off). */
  agentCount: number;
  /** On an agent's list: that agent's switch. */
  enabled?: boolean;
  fileCount: number;
  skipped: SkippedFile[];
  lastError: string | null;
  updatedAt: string;
  /** vs the repo's latest known commit. */
  status: "current" | "behind" | "error";
  repoSha: string | null;
  checkedAt: string | null;
}

/** A skill as listed live from the repo. */
export interface RepoSkill {
  path: string;
  folder: string;
  plugin: string | null;
  fileCount: number;
  name: string;
  description: string;
  problem: string | null;
  /** Other folders claiming the same name (a duplicate). */
  conflicts: string[];
  added: boolean;
}

export interface RepoListing {
  repo: string;
  commitSha: string;
  truncated: boolean;
  skills: RepoSkill[];
}

const enc = encodeURIComponent;

export interface OrgLibrary {
  source: SkillSource | null;
  usage: LibraryUsage | null;
  /** "Install GitHub for skills only" is available. False when the platform
   * GitHub App runs without its ownership check: then the library can only
   * reuse a GitHub account the organization connected. */
  skillsOnlyInstall: boolean;
}

export const orgLibrary = () => apiGet<OrgLibrary>("/v1/org/skill-library");

/** Where the library's GitHub access comes from: an org connection, a
 * fresh "Install GitHub for skills only" grant, or neither (keep the
 * library's current access, to change its repo or branch). */
export type LibraryAccess =
  | { appConnectionId: string; grant?: never }
  | { grant: string; appConnectionId?: never }
  | { appConnectionId?: never; grant?: never };

/** A switch refused because agents hold skills from the current repo: the
 * caller confirms with the impact, then sends `replace: true`. */
export class LibrarySwitchConflict extends Error {
  readonly usage: LibraryUsage;
  constructor(message: string, usage: LibraryUsage) {
    super(message);
    this.name = "LibrarySwitchConflict";
    this.usage = usage;
  }
}

const usageOf = (details: unknown): LibraryUsage | null =>
  typeof details === "object" &&
  details !== null &&
  "skillNames" in details &&
  Array.isArray(details.skillNames) &&
  "agentCount" in details &&
  typeof details.agentCount === "number"
    ? {
        skillNames: details.skillNames.filter(
          (n): n is string => typeof n === "string",
        ),
        agentCount: details.agentCount,
      }
    : null;

export const connect = async (
  input: LibraryAccess & { repo: string; branch?: string; replace?: boolean },
): Promise<SkillSource> => {
  try {
    return await apiPut<SkillSource>("/v1/org/skill-library", input);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      const usage = usageOf(err.details);
      if (usage) throw new LibrarySwitchConflict(err.message, usage);
    }
    throw err;
  }
};

/** A GitHub account the org connected at the org level (reusable). */
export interface LibraryGitHubAccount {
  appConnectionId: string;
  installationId: string;
  account: string | null;
  accountType: string | null;
}

export const githubAccounts = () =>
  apiGet<LibraryGitHubAccount[]>("/v1/org/skill-library/github-accounts");

/** The GitHub App installation an access reaches (which GitHub page
 * manages its repos). */
export interface LibraryInstallation {
  installationId: string;
  account: string | null;
  /** "Organization" or "User". */
  accountType: string | null;
}

export interface AccessRepos {
  repos: string[];
  truncated: boolean;
  installation: LibraryInstallation;
}

/** The repos the given access can read (the connect dialog's repo menu),
 * and the installation it reaches. */
export const accessRepos = (access: LibraryAccess) =>
  apiPost<AccessRepos>("/v1/org/skill-library/access/repositories", access);

export const disconnect = () => apiDelete("/v1/org/skill-library");

export const orgRepoSkills = () =>
  apiGet<RepoListing>("/v1/org/skill-library/repo-skills");

export const resync = (name: string) =>
  apiPost<LibrarySkill>(`/v1/org/skill-library/skills/${enc(name)}/syncs`, {});

export const agentLibrary = (agentId: string) =>
  apiGet<{ skills: LibrarySkill[] }>(
    `/v1/agents/${enc(agentId)}/library-skills`,
  );

export const agentAvailable = (agentId: string) =>
  apiGet<RepoListing>(`/v1/agents/${enc(agentId)}/library-skills/available`);

export const attach = (agentId: string, name: string) =>
  apiPut<LibrarySkill>(
    `/v1/agents/${enc(agentId)}/library-skills/${enc(name)}`,
    {},
  );

export const detach = (agentId: string, name: string) =>
  apiDelete(`/v1/agents/${enc(agentId)}/library-skills/${enc(name)}`);

export const setEnabled = (agentId: string, name: string, enabled: boolean) =>
  apiPatch<LibrarySkill>(
    `/v1/agents/${enc(agentId)}/library-skills/${enc(name)}`,
    { enabled },
  );
