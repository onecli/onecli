/**
 * Read-only reader for a Git repo of skills.
 *
 * Pure functions over GitHub's REST API, given an installation token the
 * caller minted for ONE repo. Discovery follows the Agent Skills standard:
 * any directory holding a `SKILL.md` is a skill, wherever it sits
 * (`plugins/<p>/skills/<s>`, `.claude/skills`, `.agents/skills`,
 * `.github/skills`, …). A Claude marketplace layout only adds the plugin
 * name used for grouping.
 */
import {
  MAX_SYNC_PARTS,
  MAX_SYNC_PART_BYTES,
  homeRelativePathSchema,
  syncFrameByteLength,
} from "@onecli/agent-protocol";
import { GITHUB_API_HEADERS } from "./github-app";

/** Standard: lowercase letters, digits and single hyphens, ≤64. */
export const LIBRARY_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const LIBRARY_SKILL_NAME_MAX = 64;
/** Standard: description ≤1024 characters. */
const LIBRARY_SKILL_DESCRIPTION_MAX = 1024;

/** Per-skill fetch caps (v1: text files only). Anything over is skipped
 * with a visible reason, never silently dropped. These bound what is
 * DOWNLOADED; whether a file can be DELIVERED is `fileFitsSyncFrame`, which
 * measures the serialized frame (JSON escaping can double a file's size). */
export const LIBRARY_MAX_FILES_PER_SKILL = 100;
export const LIBRARY_MAX_FILE_BYTES = 120_000;
const LIBRARY_MAX_SKILL_BYTES = 500_000;
/** Depth inside the skill folder (references/api/v2.md = 3). */
export const LIBRARY_MAX_FILE_DEPTH = 4;

const SKILL_FILE = "SKILL.md";
/** Where skills land in an agent's home (the composer's root). */
const HOME_SKILLS_ROOT = ".agents/skills";
/** One GitHub request's deadline: a hung read must not hold a refresh. */
const GITHUB_TIMEOUT_MS = 15_000;
/** Concurrent GitHub reads per listing or skill: well under GitHub's
 * secondary limit of 100 concurrent requests. */
const GITHUB_CONCURRENCY = 8;
/** The most skills one listing reads. A repo past it is listed partially
 * (`truncated`): each skill costs a SKILL.md read, and the listing must stay
 * cheap for the shared API whatever a repo's owner pushes. */
export const LIBRARY_MAX_LISTED_SKILLS = 1_000;

/** Why two folders can't both be used: they claim the same name. */
export const DUPLICATE_NAME_PROBLEM = "Name used twice in the repo";

export interface RepoTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  mode: string;
  sha: string;
  size?: number;
}

export interface RepoTree {
  commitSha: string;
  entries: RepoTreeEntry[];
  truncated: boolean;
}

export interface DiscoveredSkill {
  /** Folder in the repo, e.g. "plugins/data-tools/skills/snowflake". */
  path: string;
  /** Folder name (what the standard requires `name` to equal). */
  folder: string;
  plugin: string | null;
  fileCount: number;
}

export interface RepoSkill extends DiscoveredSkill {
  name: string;
  description: string;
  /** Why this skill can't be added, or null when it can. */
  problem: string | null;
  /** Other folders in the repo that claim the same name (duplicates only). */
  conflicts: string[];
}

export interface FetchedSkillFile {
  path: string;
  content: string;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export class GitHubReadError extends Error {
  readonly status: number;
  /** Seconds until GitHub accepts requests again (rate limited only). */
  readonly retryAfterSeconds: number | null;
  constructor(
    message: string,
    status: number,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "GitHubReadError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * A rate-limit refusal's wait, per GitHub's docs: `retry-after` when sent,
 * else `x-ratelimit-reset` once the remaining budget is 0, else (a secondary
 * limit with neither) at least one minute. Null when the 403/429 is not a
 * rate limit at all.
 */
const rateLimitWait = (res: Response, message: string): number | null => {
  if (res.status !== 403 && res.status !== 429) return null;
  const retryAfter = Number(res.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter;
  if (res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) {
      return Math.max(1, Math.ceil(reset - Date.now() / 1000));
    }
  }
  return res.status === 429 || /rate limit/i.test(message) ? 60 : null;
};

const ghFetch = async (url: string, token: string): Promise<Response> => {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { ...GITHUB_API_HEADERS, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch {
    throw new GitHubReadError("GitHub did not respond in time", 504);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    const message = body.message ?? `GitHub request failed: ${res.status}`;
    throw new GitHubReadError(message, res.status, rateLimitWait(res, message));
  }
  return res;
};

const repoUrl = (repo: string) => {
  const [owner, name] = repo.split("/");
  return `https://api.github.com/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}`;
};

/** The branch head commit. */
export const fetchBranchHead = async (
  token: string,
  repo: string,
  branch: string,
): Promise<string> => {
  const res = await ghFetch(
    `${repoUrl(repo)}/commits/${encodeURIComponent(branch)}`,
    token,
  );
  const data = (await res.json()) as { sha?: string };
  if (!data.sha) throw new GitHubReadError("Branch has no head commit", 404);
  return data.sha;
};

const readTree = async (
  token: string,
  repo: string,
  treeSha: string,
  recursive: boolean,
): Promise<{ entries: RepoTreeEntry[]; truncated: boolean }> => {
  const res = await ghFetch(
    `${repoUrl(repo)}/git/trees/${encodeURIComponent(treeSha)}${recursive ? "?recursive=1" : ""}`,
    token,
  );
  const data = (await res.json()) as {
    tree?: RepoTreeEntry[];
    truncated?: boolean;
  };
  return { entries: data.tree ?? [], truncated: data.truncated === true };
};

/** The whole tree at one commit (one request). GitHub truncates a recursive
 * listing past 100,000 entries or 7 MB; `truncated` then says the listing is
 * partial and a skill's folder must be read on its own (`skillFolderTree`). */
export const fetchRepoTree = async (
  token: string,
  repo: string,
  commitSha: string,
): Promise<RepoTree> => ({
  commitSha,
  ...(await readTree(token, repo, commitSha, true)),
});

/**
 * One skill folder's entries, complete even when the repo listing was
 * truncated: GitHub's documented fallback is to walk the tree non-recursively
 * down to the folder, then list that subtree on its own. Paths come back
 * repo-relative, like a full listing's. Null when the folder is gone.
 */
export const skillFolderTree = async (
  token: string,
  repo: string,
  tree: RepoTree,
  skillPath: string,
): Promise<RepoTree | null> => {
  if (!tree.truncated) return tree;
  let treeSha = tree.commitSha;
  for (const segment of skillPath.split("/")) {
    const level = await readTree(token, repo, treeSha, false);
    const next = level.entries.find(
      (e) => e.path === segment && e.type === "tree",
    );
    if (!next) return null;
    treeSha = next.sha;
  }
  const folder = await readTree(token, repo, treeSha, true);
  if (folder.truncated) {
    throw new GitHubReadError("This skill's folder is too large to read", 422);
  }
  return {
    commitSha: tree.commitSha,
    truncated: false,
    entries: folder.entries.map((e) => ({
      ...e,
      path: `${skillPath}/${e.path}`,
    })),
  };
};

/** One blob's bytes as UTF-8, or null when it is not valid text. */
const fetchBlobText = async (
  token: string,
  repo: string,
  sha: string,
): Promise<string | null> => {
  const res = await ghFetch(
    `${repoUrl(repo)}/git/blobs/${encodeURIComponent(sha)}`,
    token,
  );
  const data = (await res.json()) as { content?: string; encoding?: string };
  if (data.encoding !== "base64" || typeof data.content !== "string") {
    return null;
  }
  return decodeUtf8Text(Buffer.from(data.content, "base64"));
};

/** Strict UTF-8 decode; binary (or NUL-bearing) bytes answer null. */
export const decodeUtf8Text = (bytes: Uint8Array): string | null => {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

/**
 * The plugin a skill folder belongs to, from the Claude marketplace layout
 * (`…/<plugin>/skills/<skill>`). Null for plain layouts.
 */
const pluginOf = (path: string): string | null => {
  const segments = path.split("/");
  const at = segments.lastIndexOf("skills");
  if (at < 1 || at !== segments.length - 2) return null;
  const owner = segments[at - 1];
  if (!owner || owner.startsWith(".")) return null;
  return owner;
};

/** The nearest proper ancestor folder of `path` that is in `folders`. */
const nearestAncestorIn = (
  path: string,
  folders: Set<string>,
): string | undefined => {
  for (let at = path.lastIndexOf("/"); at > 0; ) {
    const dir = path.slice(0, at);
    if (folders.has(dir)) return dir;
    at = dir.lastIndexOf("/");
  }
  return undefined;
};

/** `tree` with only the entries inside the given skill folders: all a fetch
 * of one of those skills reads (one ancestor walk per entry). */
export const treeOfSkills = (
  tree: RepoTree,
  skillPaths: string[],
): RepoTree => {
  const folders = new Set(skillPaths);
  return {
    ...tree,
    entries: tree.entries.filter(
      (e) => nearestAncestorIn(e.path, folders) !== undefined,
    ),
  };
};

/**
 * Every skill folder in a tree: a directory holding SKILL.md. A skill nested
 * inside another skill is not a separate skill (it is part of the outer one).
 * Symlinks (120000) and submodules ("commit") never count. One pass over the
 * tree whatever its size (it can hold 100,000 entries).
 */
export const discoverSkills = (tree: RepoTree): DiscoveredSkill[] => {
  const blobs = tree.entries.filter(
    (e) => e.type === "blob" && e.mode !== "120000",
  );
  const folders = blobs
    .filter((e) => e.path === SKILL_FILE || e.path.endsWith(`/${SKILL_FILE}`))
    .map((e) => e.path.slice(0, -SKILL_FILE.length).replace(/\/$/, ""))
    .filter((folder) => folder !== "")
    .sort();
  // Sorted, a folder comes after every folder that contains it, so a folder
  // is outer unless one of its ancestors already is (a lookup per ancestor,
  // never a scan of every outer folder).
  const outerSet = new Set<string>();
  const outer: string[] = [];
  for (const folder of folders) {
    if (nearestAncestorIn(folder, outerSet) === undefined) {
      outerSet.add(folder);
      outer.push(folder);
    }
  }
  // Each blob counts toward the outer skill folder it sits under.
  const fileCount = new Map(outer.map((path) => [path, 0]));
  for (const blob of blobs) {
    const owner = nearestAncestorIn(blob.path, outerSet);
    if (owner !== undefined) {
      fileCount.set(owner, (fileCount.get(owner) ?? 0) + 1);
    }
  }
  return outer.map((path) => ({
    path,
    folder: path.split("/").pop() ?? path,
    plugin: pluginOf(path),
    fileCount: fileCount.get(path) ?? 0,
  }));
};

/**
 * Two folders that claim the same name can't both be stored (one name, one
 * folder in an agent's home), and picking one would be a silent guess. Every
 * claimant is marked, with the other folders, so the repo owner can fix it.
 * Only otherwise-valid skills claim a name.
 */
export const markDuplicateNames = (skills: RepoSkill[]): RepoSkill[] => {
  const byName = new Map<string, string[]>();
  for (const skill of skills) {
    if (skill.problem) continue;
    byName.set(skill.name, [...(byName.get(skill.name) ?? []), skill.path]);
  }
  return skills.map((skill) => {
    const paths = skill.problem ? [] : (byName.get(skill.name) ?? []);
    return paths.length > 1
      ? {
          ...skill,
          problem: DUPLICATE_NAME_PROBLEM,
          conflicts: paths.filter((p) => p !== skill.path),
        }
      : skill;
  });
};

/**
 * The two frontmatter fields the standard requires. A deliberately small
 * reader (no YAML dependency): plain, quoted, and folded/literal block
 * scalars (`>`, `>-`, `|`, `|-`) for `name` and `description`.
 */
export const parseSkillFrontmatter = (
  text: string,
): { name: string | null; description: string | null } => {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match?.[1]) return { name: null, description: null };
  const lines = match[1].split("\n");
  const read = (key: string): string | null => {
    const at = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
    if (at < 0) return null;
    const raw = (lines[at] ?? "").slice(key.length + 1).trim();
    const block = /^([>|])[+-]?$/.exec(raw);
    if (block) {
      const body: string[] = [];
      for (const line of lines.slice(at + 1)) {
        if (line.trim() !== "" && !/^\s/.test(line)) break;
        body.push(line.trim());
      }
      const joined =
        block[1] === ">"
          ? body.join(" ").replace(/\s+/g, " ")
          : body.join("\n");
      return joined.trim() || null;
    }
    const quoted = /^(["'])([\s\S]*)\1$/.exec(raw);
    const value = quoted ? (quoted[2] ?? "") : raw;
    return value.trim() || null;
  };
  return { name: read("name"), description: read("description") };
};

/** Why a skill can't be added (standard checks), or null. */
export const skillProblem = (
  skill: DiscoveredSkill,
  front: { name: string | null; description: string | null },
): string | null => {
  if (!front.name) return "SKILL.md has no name in its frontmatter";
  if (
    front.name.length > LIBRARY_SKILL_NAME_MAX ||
    !LIBRARY_SKILL_NAME_PATTERN.test(front.name)
  ) {
    return "Name must be lowercase words separated by single hyphens (≤64)";
  }
  if (front.name !== skill.folder) {
    return `Name "${front.name}" doesn't match its folder "${skill.folder}"`;
  }
  if (front.name === "onecli-gateway") {
    return "That name is reserved for the built-in gateway skill";
  }
  if (!front.description) return "SKILL.md has no description";
  if (front.description.length > LIBRARY_SKILL_DESCRIPTION_MAX) {
    return "Description is longer than 1,024 characters";
  }
  return null;
};

/** A relative file path inside a skill folder that is safe to materialize. */
export const isSafeSkillFilePath = (rel: string): boolean => {
  if (rel === "" || rel.startsWith("/") || rel.includes("\\")) return false;
  if (rel.includes("\0")) return false;
  const segments = rel.split("/");
  if (segments.length > LIBRARY_MAX_FILE_DEPTH) return false;
  return segments.every(
    (seg) => seg !== "" && seg !== "." && seg !== ".." && seg.length <= 128,
  );
};

/**
 * Whether one file of skill `name` fits a home-sync frame on its own: the
 * serialized frame, measured exactly as the sender's packer measures it
 * (worst-case part stamps), never the raw byte size. A file that fails this
 * would be dropped at delivery, so it is refused at fetch instead.
 */
export const fileFitsSyncFrame = (
  name: string,
  file: FetchedSkillFile,
): boolean =>
  syncFrameByteLength({
    kind: "skills.changed",
    generation: 2_147_483_647,
    part: MAX_SYNC_PARTS,
    of: MAX_SYNC_PARTS,
    files: [
      {
        path: `${HOME_SKILLS_ROOT}/${name}/${file.path}`,
        content: file.content,
      },
    ],
  }) <= MAX_SYNC_PART_BYTES;

/** "SKILL.md is too large to deliver" (and its siblings): the visible
 * reason a file is left out. */
const TOO_LARGE_TO_DELIVER = "Too large to deliver to an agent";

/**
 * Fetch one skill folder's files (text only in v1). SKILL.md is mandatory;
 * every other file that can't be carried is reported in `skipped`. `tree`
 * must hold the folder's complete listing (see `skillFolderTree`).
 */
export const fetchSkillFiles = async (
  token: string,
  repo: string,
  tree: RepoTree,
  skillPath: string,
  name: string,
): Promise<{ files: FetchedSkillFile[]; skipped: SkippedFile[] }> => {
  const prefix = `${skillPath}/`;
  const entries = tree.entries.filter((e) => e.path.startsWith(prefix));
  const files: FetchedSkillFile[] = [];
  const skipped: SkippedFile[] = [];
  let total = 0;
  const ordered = [...entries].sort((a, b) =>
    a.path === `${prefix}${SKILL_FILE}`
      ? -1
      : b.path === `${prefix}${SKILL_FILE}`
        ? 1
        : a.path.localeCompare(b.path),
  );
  // Plan first (every cap decided from the tree's sizes, in order), then
  // fetch the planned blobs in parallel: one GitHub round trip per file,
  // run sequentially, made a 50-file skill take ~10s to add.
  const planned: { rel: string; sha: string; size: number }[] = [];
  for (const entry of ordered) {
    const rel = entry.path.slice(prefix.length);
    if (entry.type === "tree") continue;
    if (entry.type === "commit") {
      skipped.push({ path: rel, reason: "Git submodule" });
      continue;
    }
    if (entry.mode === "120000") {
      skipped.push({ path: rel, reason: "Symbolic link" });
      continue;
    }
    if (!isSafeSkillFilePath(rel)) {
      skipped.push({ path: rel, reason: "Path too deep or not allowed" });
      continue;
    }
    // The sync wire caps a home path's length: a longer one couldn't be
    // delivered (and must never reach a sync, which the runner reads whole).
    if (
      !homeRelativePathSchema.safeParse(`${HOME_SKILLS_ROOT}/${name}/${rel}`)
        .success
    ) {
      skipped.push({ path: rel, reason: "Path too long" });
      continue;
    }
    if (rel.toLowerCase() === "skill.md" && rel !== SKILL_FILE) {
      skipped.push({ path: rel, reason: "Conflicts with SKILL.md" });
      continue;
    }
    if (planned.length >= LIBRARY_MAX_FILES_PER_SKILL) {
      skipped.push({ path: rel, reason: "Too many files in this skill" });
      continue;
    }
    const size = entry.size ?? 0;
    if (size > LIBRARY_MAX_FILE_BYTES) {
      skipped.push({ path: rel, reason: "File is larger than 120 KB" });
      continue;
    }
    if (total + size > LIBRARY_MAX_SKILL_BYTES) {
      skipped.push({ path: rel, reason: "Skill is larger than 500 KB" });
      continue;
    }
    total += size;
    planned.push({ rel, sha: entry.sha, size });
  }

  const contents = await mapLimit(planned, GITHUB_CONCURRENCY, (p) =>
    fetchBlobText(token, repo, p.sha),
  );
  planned.forEach((p, i) => {
    const content = contents[i];
    if (content === null || content === undefined) {
      skipped.push({ path: p.rel, reason: "Binary file (not supported yet)" });
      return;
    }
    const file = { path: p.rel, content };
    if (!fileFitsSyncFrame(name, file)) {
      skipped.push({ path: p.rel, reason: TOO_LARGE_TO_DELIVER });
      return;
    }
    files.push(file);
  });
  return { files, skipped };
};

/** `items.map(fn)` with at most `limit` in flight; results keep order. */
const mapLimit = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
};

/**
 * The skills in `tree`, with their name and description read from SKILL.md
 * (at most GITHUB_CONCURRENCY reads in flight), standard problems checked,
 * and duplicate names marked. A SKILL.md larger than a file may be is not
 * downloaded at all. Past LIBRARY_MAX_LISTED_SKILLS folders only the first
 * (path order) are read, and `capped` says the list is partial.
 */
export const listSkills = async (
  token: string,
  repo: string,
  tree: RepoTree,
): Promise<{ skills: RepoSkill[]; capped: boolean }> => {
  const byPath = new Map(tree.entries.map((e) => [e.path, e]));
  const discovered = discoverSkills(tree);
  const found = discovered.slice(0, LIBRARY_MAX_LISTED_SKILLS);
  const skills = await mapLimit(
    found,
    GITHUB_CONCURRENCY,
    async (skill): Promise<RepoSkill> => {
      const entry = byPath.get(`${skill.path}/${SKILL_FILE}`);
      const tooLarge = (entry?.size ?? 0) > LIBRARY_MAX_FILE_BYTES;
      const text =
        entry && !tooLarge ? await fetchBlobText(token, repo, entry.sha) : null;
      const front = text
        ? parseSkillFrontmatter(text)
        : { name: null, description: null };
      const name = front.name ?? skill.folder;
      return {
        ...skill,
        name,
        description: front.description ?? "",
        conflicts: [],
        problem: tooLarge
          ? `${SKILL_FILE} is larger than 120 KB`
          : text === null
            ? `${SKILL_FILE} isn't text`
            : (skillProblem(skill, front) ??
              (fileFitsSyncFrame(name, { path: SKILL_FILE, content: text })
                ? null
                : `${SKILL_FILE} is ${TOO_LARGE_TO_DELIVER.toLowerCase()}`)),
      };
    },
  );
  return {
    skills: markDuplicateNames(skills),
    capped: discovered.length > found.length,
  };
};

/**
 * The skill at `skillPath`, read through its own folder: what a truncated
 * repo listing can't show. Null when the folder (or its SKILL.md) is gone.
 * Duplicate names can't be checked repo-wide from here.
 */
export const skillAt = async (
  token: string,
  repo: string,
  tree: RepoTree,
  skillPath: string,
): Promise<RepoSkill | null> => {
  const folder = await skillFolderTree(token, repo, tree, skillPath);
  if (!folder) return null;
  const { skills } = await listSkills(token, repo, folder);
  return skills.find((s) => s.path === skillPath) ?? null;
};
