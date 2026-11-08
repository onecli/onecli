import { createHash } from "node:crypto";
import { db } from "@onecli/db";
import {
  MAX_SYNC_FILE_CHUNKS,
  MAX_SYNC_PART_BYTES,
  MAX_SYNC_PARTS,
  SYNC_FILE_CHUNK_RAW_BYTES,
  foldedScalar,
  homeRelativePathSchema,
  renderMemoryFile,
  syncFrameByteLength,
  type RunnerWorkItem,
  type HomeSyncFile,
  type HomeSyncBlob,
} from "@onecli/agent-protocol";
import {
  MAX_IMPORTED_SKILL_BYTES,
  SKILL_FILE_MAX_DEPTH,
  cleanSkillDescription,
} from "../validations/skills";
import { getGatewaySkill } from "../lib/skills/gateway-skill";
import { LIBRARY_MAX_FILE_DEPTH } from "../apps/github-skill-repo";
import { channelPresencesForRender } from "./channels/agent-channel-service";
import { peersForRender } from "./channels/agent-peer-roster";
import { connectionsForRender } from "./agent-connections-render";
import {
  MEMORY_INDEX_LINE_CLIP,
  clipLine,
  indexLineText,
} from "../lib/memory-index";
import { signalWork } from "./due-work";
import { logger } from "../lib/logger";

const log = logger.child({ component: "home-sync" });

/**
 * The home projection (step 9, §3.7/§3.8): what a sandbox's managed
 * roots must contain, composed at DISPATCH time from current truth: user
 * skills (two tiers, agent over organization), the library skills the agent
 * added from its org's Git repo, the builtin gateway skill, and the memory
 * file projection. This module owns the desired-side of the
 * sync clock (the bumps) and the sync item's byte-budgeted part packing;
 * dueness and claims stay in due-work.ts (invariant 15), and the
 * supervisor's materializer owns the writes.
 */

const SKILLS_ROOT = ".agents/skills";
const MEMORY_ROOT = "memory";

/**
 * The most one agent's library skills may add to the prune manifest the
 * sync's FINAL part carries (every file path, JSON-encoded). Adds and
 * refreshes are refused past it, which keeps a typical agent's final part
 * well inside the frame. Beside a pathological rest-of-agent (every other
 * cap maxed) it can still not fit, so the sync composer measures the real
 * final part and leaves library skills out rather than refuse the sync
 * (`fitSkillsToSync`).
 */
export const LIBRARY_MANIFEST_BUDGET_BYTES = 24_000;

/**
 * The most one agent's library skills may add to its file parts, as
 * serialized frame bytes (JSON escaping included, so a repo's raw sizes can't
 * understate it). The greedy packer fills each part past half a frame, so
 * this is at most ~120 parts: beside a typical agent's authored skills and
 * memory that stays inside MAX_SYNC_PARTS. Adds and refreshes are refused
 * past it; against a pathological rest-of-agent the composer leaves library
 * skills out rather than let truncation reach an authored or memory file
 * (`fitSkillsToSync`).
 */
export const LIBRARY_SYNC_BUDGET_BYTES = 60 * MAX_SYNC_PART_BYTES;

/** The manifest bytes one skill's file paths cost on the final part (each
 * path's JSON string plus its separating comma): the measure behind the
 * library's manifest budget and the tiers' (SKILL_TIER_BUDGETS). */
export const skillManifestBytes = (name: string, paths: string[]): number =>
  paths.reduce(
    (sum, path) =>
      sum +
      new TextEncoder().encode(JSON.stringify(`${SKILLS_ROOT}/${name}/${path}`))
        .length +
      1,
    0,
  );

/** The file-part bytes one library skill costs: each file as it serializes
 * inside a frame (path and content JSON-encoded, plus its separator). */
export const librarySyncBytes = (
  name: string,
  files: { path: string; content: string }[],
): number =>
  files.reduce(
    (sum, file) =>
      sum +
      syncFrameByteLength({
        path: `${SKILLS_ROOT}/${name}/${file.path}`,
        content: file.content,
      }) +
      1,
    0,
  );

export interface HomeFile {
  path: string;
  content: string;
  /** Binary bytes (content is then ""). */
  data?: Uint8Array | null;
  executable?: boolean;
}

// ── The bumps (the desired side of the sync clock) ──────────────────────────
// One fenced updateMany each + the poll wake. Bumps touch EVERY matching
// sandbox regardless of status — monotonic and race-free — while the due
// arm's `status = 'running'` filter is what keeps a bump from ever waking a
// parked sandbox (the credential-edit precedent): a parked one re-syncs at
// its next boot, whose start claim resets `applied` to 0.

export const bumpHomeForAgent = async (agentId: string): Promise<void> => {
  const { count } = await db.sandbox.updateMany({
    where: { agentId },
    data: { homeDesiredGeneration: { increment: 1 } },
  });
  if (count > 0) signalWork();
};

/** The bump for a known set of agents (say, the holders of a changed
 * library skill), so agents that can't see the change aren't recomposed. */
export const bumpHomeForAgents = async (agentIds: string[]): Promise<void> => {
  if (agentIds.length === 0) return;
  const { count } = await db.sandbox.updateMany({
    where: { agentId: { in: agentIds } },
    data: { homeDesiredGeneration: { increment: 1 } },
  });
  if (count > 0) signalWork();
};

export const bumpHomeForWorkspace = async (
  workspaceId: string,
): Promise<void> => {
  const { count } = await db.sandbox.updateMany({
    where: { agent: { workspaceId } },
    data: { homeDesiredGeneration: { increment: 1 } },
  });
  if (count > 0) signalWork();
};

export const bumpHomeForOrganization = async (
  organizationId: string,
): Promise<void> => {
  const { count } = await db.sandbox.updateMany({
    where: { agent: { workspace: { organizationId } } },
    data: { homeDesiredGeneration: { increment: 1 } },
  });
  if (count > 0) signalWork();
};

/**
 * The bump for a resource scope: every agent that could see a change at
 * that level (a workspace's connections, an org's connections or policy).
 * A scope with neither id reaches no sandbox and is a no-op.
 */
export const bumpHomeForScope = async (scope: {
  workspaceId?: string;
  organizationId?: string;
}): Promise<void> => {
  if (scope.workspaceId) await bumpHomeForWorkspace(scope.workspaceId);
  else if (scope.organizationId)
    await bumpHomeForOrganization(scope.organizationId);
};

// ── The composer ────────────────────────────────────────────────────────────

// `foldedScalar` and the memory-file render live in @onecli/agent-protocol
// (the supervisor's harvester parses and checksum-verifies the exact same
// bytes); skills stay local — they have no write-back side — but share the
// one folded-scalar definition so their frontmatter can't drift from it.

const renderSkillMd = (skill: {
  name: string;
  description: string;
  content: string;
  scope: string;
}): string =>
  [
    "---",
    `name: ${skill.name}`,
    // Cleaned again here: rows stored before every door cleaned (or written
    // straight to the database) still reach the agent as one plain line.
    `description: ${foldedScalar(cleanSkillDescription(skill.description))}`,
    "---",
    `<!-- Managed by OneCLI (${skill.scope} skill) — regenerated from the dashboard; edits here are overwritten. -->`,
    "",
    skill.content,
    "",
  ].join("\n");

const renderMemoryIndex = (
  memories: {
    key: string;
    title: string | null;
    description: string | null;
    content: string;
  }[],
): string =>
  [
    "# Memory index",
    "",
    "<!-- Managed by OneCLI — read-only projection of this agent's memory. -->",
    "",
    ...memories.map(
      (memory) =>
        `- [${memory.key}](./${memory.key}.md): ${clipLine(
          indexLineText(memory),
          MEMORY_INDEX_LINE_CLIP,
        )}`,
    ),
    "",
  ].join("\n");

/** Segments a skill file's home path may have: the root (2) + the name + the
 * file's path inside the folder (up to SKILL_FILE_MAX_DEPTH for authored and
 * imported skills, LIBRARY_MAX_FILE_DEPTH for library skills). */
const AUTHORED_SKILL_SEGMENTS = 3 + SKILL_FILE_MAX_DEPTH;
const LIBRARY_SKILL_SEGMENTS = 3 + LIBRARY_MAX_FILE_DEPTH;

/** The containment braces: the belt (validations, the library fetch) makes a
 * violating path unreachable through any door, so a failure here marks DB
 * tampering or a bug — the file's whole skill is skipped, never thrown (one
 * poisoned row must not brick the agent's sync). The wire's own path rule
 * comes first: the runner parses a poll response whole, so one path it
 * rejects would cost every sandbox on that runner its work. */
const isContainedPath = (
  path: string,
  skillSegments = AUTHORED_SKILL_SEGMENTS,
): boolean => {
  if (!homeRelativePathSchema.safeParse(path).success) return false;
  const segments = path.split("/").length;
  if (path.startsWith(`${SKILLS_ROOT}/`)) return segments <= skillSegments;
  if (path.startsWith(`${MEMORY_ROOT}/`)) return segments <= 2;
  return false;
};

interface EffectiveSkill {
  name: string;
  description: string;
  content: string;
  scope: string;
  files: SkillFileRow[];
}

type SkillFileRow = {
  path: string;
  content: string;
  data: Uint8Array | null;
  executable: boolean;
};

/**
 * The two tiers a sandbox's agent can see, UNSHADOWED — enabled rows only
 * (a paused row leaves the projection; it never tombstones the org tier).
 * Projection logic owns this query rather than skill-service to keep the
 * import direction acyclic (skill-service imports the bumps from here).
 */
const listEffectiveSkills = async (
  agentId: string,
  organizationId: string,
): Promise<{
  agent: EffectiveSkill[];
  organization: EffectiveSkill[];
}> => {
  const select = {
    name: true,
    description: true,
    content: true,
    scope: true,
    files: {
      select: { path: true, content: true, data: true, executable: true },
    },
  } as const;
  const [agentRows, orgRows] = await Promise.all([
    db.skill.findMany({ where: { agentId, enabled: true }, select }),
    db.skill.findMany({
      where: { organizationId, enabled: true },
      select,
    }),
  ]);
  return { agent: agentRows, organization: orgRows };
};

/**
 * Library skills this agent added and has switched on. Read here, not in
 * skill-library-service, to keep the import direction acyclic.
 */
const listLibrarySkills = (agentId: string, organizationId: string) =>
  db.librarySkill.findMany({
    where: {
      source: { organizationId },
      attachments: { some: { agentId, enabled: true } },
    },
    select: {
      name: true,
      files: { select: { path: true, content: true } },
    },
    orderBy: { name: "asc" },
  });

/** The file order every composed set is in: the packer's deterministic order. */
const byPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/** One skill's home files, or null when one of them breaks the braces (the
 * whole skill is then left out and logged, never thrown). */
const containedSkillFiles = (
  agentId: string,
  name: string,
  skillFiles: {
    path: string;
    content: string;
    data?: Uint8Array | null;
    executable?: boolean;
  }[],
  maxSegments: number,
): HomeFile[] | null => {
  const files = skillFiles.map((file) => ({
    path: `${SKILLS_ROOT}/${name}/${file.path}`,
    content: file.content,
    data: file.data ?? null,
    executable: file.executable ?? false,
  }));
  const poisoned = files.find(
    (file) =>
      !isContainedPath(file.path, maxSegments) ||
      (file.data === null && file.content.length > MAX_IMPORTED_SKILL_BYTES) ||
      (file.data !== null && file.data.byteLength > MAX_IMPORTED_SKILL_BYTES),
  );
  if (!poisoned) return files;
  log.error(
    { agentId, skill: name, path: poisoned.path },
    "skill violates containment; skipping it whole",
  );
  return null;
};

/** A skill the sync may leave out when everything can't fit, and the files
 * that come back if it does: a library skill gives its name back to the
 * agent's own skill it hides; a user skill restores nothing. */
export interface ProjectedSkill {
  name: string;
  shadows: HomeFile[];
}

/** The bytes a skill's files put on the computer: its leave-out size. */
const rawBytes = (files: HomeFile[]): number =>
  files.reduce(
    (sum, file) =>
      sum +
      (file.data ? file.data.byteLength : Buffer.byteLength(file.content)),
    0,
  );

/** The one agent read the projection needs — every field, once. */
const loadProjectionAgent = async (agentId: string) => {
  const agent = await db.agent.findUnique({
    where: { id: agentId },
    select: {
      harness: true,
      name: true,
      instructions: true,
      workspace: { select: { organizationId: true } },
    },
  });
  if (!agent) return null;
  return {
    organizationId: agent.workspace.organizationId,
    harness: agent.harness,
    name: agent.name,
    instructions: agent.instructions,
  };
};

export type ProjectionAgent = NonNullable<
  Awaited<ReturnType<typeof loadProjectionAgent>>
>;

/**
 * The full desired file set for one agent's home, deterministic
 * (path-sorted), plus the skills the sync may leave out, in the order it
 * would (`fitSkillsToSync`): library skills last-by-name first, then the
 * agent's and organization's skills, largest first.
 * Shadowing: the Map fills organization → agent, so the agent's own skill
 * overwrites a same-named org skill; a library skill wins over both.
 */
const composeHomeFiles = async (
  agentId: string,
  agent: ProjectionAgent,
): Promise<{ files: HomeFile[]; skills: ProjectedSkill[] }> => {
  const [tiers, memories, attached] = await Promise.all([
    listEffectiveSkills(agentId, agent.organizationId),
    db.agentMemory.findMany({
      where: { agentId },
      orderBy: { key: "asc" },
      select: { key: true, title: true, description: true, content: true },
    }),
    listLibrarySkills(agentId, agent.organizationId),
  ]);

  const files: HomeFile[] = [];

  // (a) The builtin gateway skill — byte-identical to /v1/skill/gateway's
  // answer for this harness (not in HOOK_BASED_AGENTS → the broad variant).
  files.push({
    path: `${SKILLS_ROOT}/onecli-gateway/SKILL.md`,
    content: getGatewaySkill(agent.harness ?? undefined),
  });

  // (b) User skills, shadow-merged (agent > organization).
  const byName = new Map<string, EffectiveSkill>();
  for (const skill of [...tiers.organization, ...tiers.agent]) {
    byName.set(skill.name, skill);
  }
  byName.delete("onecli-gateway"); // braces — the belt refuses it at create
  const authored = new Map<string, HomeFile[]>();
  for (const skill of byName.values()) {
    const skillFiles = containedSkillFiles(
      agentId,
      skill.name,
      [{ path: "SKILL.md", content: renderSkillMd(skill) }, ...skill.files],
      AUTHORED_SKILL_SEGMENTS,
    );
    if (skillFiles) authored.set(skill.name, skillFiles);
  }

  // (b2) Library skills from the org's connected Git repo, verbatim: the
  // folder as in Git (SKILL.md is the repo's own, frontmatter included). One
  // that passes the braces wins a same-name clash (the repo is the source of
  // truth; no silent drift from an agent's own copy); one that doesn't
  // shadows nothing.
  const library: ProjectedSkill[] = [];
  for (const skill of attached) {
    if (skill.name === "onecli-gateway" || skill.files.length === 0) continue;
    const skillFiles = containedSkillFiles(
      agentId,
      skill.name,
      skill.files,
      LIBRARY_SKILL_SEGMENTS,
    );
    if (!skillFiles) continue;
    files.push(...skillFiles);
    library.push({ name: skill.name, shadows: authored.get(skill.name) ?? [] });
  }
  const shadowed = new Set(library.map((skill) => skill.name));
  for (const [name, skillFiles] of authored) {
    if (!shadowed.has(name)) files.push(...skillFiles);
  }
  // Every user skill can be left out, shadowed ones too: by the time the
  // leave-out reaches them, every library skill is out and they are back.
  const userSkills = [...authored]
    .map(([name, skillFiles]) => ({ name, bytes: rawBytes(skillFiles) }))
    .sort((a, b) => b.bytes - a.bytes || (a.name < b.name ? -1 : 1))
    .map(({ name }) => ({ name, shadows: [] }));

  // (c) The memory projection (§3.8, agent-level only — the step-8 decision).
  // Zero memories → zero memory files; the sync's prune keeps the dir clean.
  // renderMemoryFile stamps the self-authenticating checksum the supervisor
  // uses to tell an untouched projection from agent-authored bytes.
  if (memories.length > 0) {
    for (const memory of memories) {
      files.push({
        path: `${MEMORY_ROOT}/${memory.key}.md`,
        content: renderMemoryFile(memory),
      });
    }
    files.push({
      path: `${MEMORY_ROOT}/index.md`,
      content: renderMemoryIndex(memories),
    });
  }

  files.sort(byPath);
  return { files, skills: [...library.reverse(), ...userSkills] };
};

/** The full desired file set for one agent's home (see `composeHomeFiles`). */
export const buildHomeFileSet = async (
  agentId: string,
  loaded?: ProjectionAgent,
): Promise<HomeFile[]> => {
  const agent = loaded ?? (await loadProjectionAgent(agentId));
  if (!agent) return [];
  return (await composeHomeFiles(agentId, agent)).files;
};

// ── The part packer ─────────────────────────────────────────────────────────

/** Derived from the wire, never re-declared: the shapes cannot drift. */
type SyncPart = Extract<
  RunnerWorkItem,
  { kind: "skills.changed" }
>["parts"][number];

const partFrameBytes = (
  generation: number,
  part: SyncPart,
  partNumber: number,
  of: number,
): number =>
  syncFrameByteLength({
    kind: "skills.changed",
    generation,
    part: partNumber,
    of,
    ...part,
  });

/** The part budget the packer works against; production uses the wire caps. */
export interface SyncBudget {
  maxParts: number;
  maxBytes: number;
}

const PRODUCTION_SYNC_BUDGET: SyncBudget = {
  maxParts: MAX_SYNC_PARTS,
  maxBytes: MAX_SYNC_PART_BYTES,
};

/** The dedicated final part's fields (everything but the files). */
export type SyncFinalExtras = Omit<SyncPart, "files" | "blobs"> & {
  prune: string[];
};

/**
 * The home files minus as many skills as it takes for the sync to carry
 * everything else: the final part, manifest included, fits the frame, and
 * the file parts fit the part cap, so the packer's truncation never reaches
 * a memory file or the gateway skill. `skills` is the leave-out order the
 * composer decided (library skills first, each giving its name back to the
 * agent's own skill it shadowed; then the agent's and organization's skills,
 * largest first). Leaving a skill out costs one skill; refusing or cutting
 * the sync short would cost the agent its memory. The import door's tier
 * budgets keep agents far from this, so it is logged as an error, never
 * expected.
 */
export const fitSkillsToSync = ({
  agentId,
  files,
  skills,
  extras,
  generation,
  budget = PRODUCTION_SYNC_BUDGET,
}: {
  agentId: string;
  files: HomeFile[];
  skills: ProjectedSkill[];
  extras: Omit<SyncFinalExtras, "prune">;
  generation: number;
  budget?: SyncBudget;
}): HomeFile[] => {
  let kept = files;
  const fits = () =>
    partFrameBytes(
      generation,
      { files: [], ...extras, prune: kept.map((file) => file.path) },
      budget.maxParts,
      budget.maxParts,
    ) <= budget.maxBytes &&
    packFileParts(kept, generation, budget).parts.length <= budget.maxParts - 1;
  const dropped: string[] = [];
  for (const skill of skills) {
    if (fits()) break;
    const prefix = `${SKILLS_ROOT}/${skill.name}/`;
    kept = [
      ...kept.filter((file) => !file.path.startsWith(prefix)),
      ...skill.shadows,
    ].sort(byPath);
    dropped.push(skill.name);
  }
  if (dropped.length > 0) {
    log.error(
      { agentId, dropped },
      "home sync over budget; leaving skills out",
    );
  }
  return kept;
};

/** One composed file as it rides the wire: a text file (as always) or a
 * blob (binary or too big for one frame as text, possibly one chunk). */
export type WireItem =
  | { kind: "file"; file: HomeSyncFile }
  | { kind: "blob"; blob: HomeSyncBlob };

/** One file's wire items, each with its own serialized bytes (what it adds
 * to a part, before the packer's separator and `blobs` key). Empty when
 * the file is past the chunk cap: the packer reports it as unfit. */
export interface WireFile {
  items: { item: WireItem; bytes: number }[];
}

/** A part's frame with no items, at the widest stamps a frame can carry. */
const BARE_FRAME_BYTES = syncFrameByteLength({
  kind: "skills.changed",
  generation: 2_147_483_647,
  part: MAX_SYNC_PARTS,
  of: MAX_SYNC_PARTS,
  files: [],
});
/** What the first blob in a part adds beyond its own bytes: `,"blobs":[]`. */
const BLOBS_KEY_BYTES =
  syncFrameByteLength({ files: [], blobs: [] }) -
  syncFrameByteLength({ files: [] });

const measured = (item: WireItem) => ({
  item,
  bytes: syncFrameByteLength(item.kind === "file" ? item.file : item.blob),
});

const encodeWireFile = (file: HomeFile): WireFile => {
  const flags = file.executable ? { executable: true as const } : {};
  if (!file.data) {
    const text = measured({
      kind: "file",
      file: { path: file.path, content: file.content, ...flags },
    });
    // Memory files are always text: the supervisor writes blobs under the
    // skills root only, and memory's own write gate proves the fit. Skill
    // text rides as text whenever it fits a frame (as every skill file did
    // before blobs existed); past that, escapes and all, it rides as bytes.
    if (
      !file.path.startsWith(`${SKILLS_ROOT}/`) ||
      BARE_FRAME_BYTES + text.bytes <= MAX_SYNC_PART_BYTES
    ) {
      return { items: [text] };
    }
  }
  const bytes = file.data
    ? Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength)
    : Buffer.from(file.content, "utf8");
  if (bytes.byteLength <= SYNC_FILE_CHUNK_RAW_BYTES) {
    return {
      items: [
        measured({
          kind: "blob",
          blob: {
            path: file.path,
            dataBase64: bytes.toString("base64"),
            ...flags,
          },
        }),
      ],
    };
  }
  const of = Math.ceil(bytes.byteLength / SYNC_FILE_CHUNK_RAW_BYTES);
  if (of > MAX_SYNC_FILE_CHUNKS) return { items: [] };
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    items: Array.from({ length: of }, (_, i) =>
      measured({
        kind: "blob",
        blob: {
          path: file.path,
          dataBase64: bytes
            .subarray(
              i * SYNC_FILE_CHUNK_RAW_BYTES,
              (i + 1) * SYNC_FILE_CHUNK_RAW_BYTES,
            )
            .toString("base64"),
          ...flags,
          chunk: { index: i + 1, of, sha256 },
        },
      }),
    ),
  };
};

/** Encoded once per composed file: the leave-out loop re-packs the same
 * files many times, and a big file's base64 and sha256 cost real time. */
const encoded = new WeakMap<HomeFile, WireFile>();

/**
 * The wire shape of one composed file. Text that fits a frame stays a plain
 * `files` entry, exactly as before (`executable` only adds a flag an older
 * supervisor ignores). Binary skill files, and skill text too big or too
 * escape-dense for one frame, become `blobs` (base64, chunked with the
 * whole file's sha256 past one chunk): an older runner or supervisor drops
 * that list, so those files are absent there rather than written scrambled.
 */
export const wireFileOf = (file: HomeFile): WireFile => {
  const known = encoded.get(file);
  if (known) return known;
  const wire = encodeWireFile(file);
  encoded.set(file, wire);
  return wire;
};

/**
 * Greedy packing of path-sorted files into BARE parts, measured with
 * WORST-CASE part/of stamps: the real numbers are stamped after packing, and
 * "9"→"17" growing by a digit could tip a razor's-edge part over the budget
 * the wire refine re-checks exactly. The part cap upper-bounds both fields'
 * widths. The running size is exact: each item's own bytes, a comma after
 * the first in its list, and the `blobs` key with a part's first blob. A
 * file with an item that can't fit even a bare part marks a row the braces
 * should have caught: it is skipped whole (and named), never emitted.
 * `done` says which part completes each packed file, so a truncated sync
 * can tell whole files from cut ones.
 */
const packFileParts = (
  homeFiles: HomeFile[],
  generation: number,
  { maxParts, maxBytes }: SyncBudget,
): {
  parts: SyncPart[];
  unfit: string[];
  done: { path: string; part: number }[];
} => {
  const empty = partFrameBytes(generation, { files: [] }, maxParts, maxParts);
  const parts: SyncPart[] = [];
  const unfit: string[] = [];
  const done: { path: string; part: number }[] = [];
  let files: HomeSyncFile[] = [];
  let blobs: HomeSyncBlob[] = [];
  let bytes = empty;
  const flush = () => {
    if (files.length === 0 && blobs.length === 0) return;
    parts.push(blobs.length > 0 ? { files, blobs } : { files });
    files = [];
    blobs = [];
    bytes = empty;
  };
  const cost = ({ item, bytes: own }: WireFile["items"][number]) =>
    item.kind === "file"
      ? own + (files.length > 0 ? 1 : 0)
      : own + (blobs.length > 0 ? 1 : BLOBS_KEY_BYTES);
  for (const file of homeFiles) {
    const { items } = wireFileOf(file);
    const fitsAlone = ({ item, bytes: own }: (typeof items)[number]) =>
      empty + own + (item.kind === "blob" ? BLOBS_KEY_BYTES : 0) <= maxBytes;
    if (items.length === 0 || !items.every(fitsAlone)) {
      unfit.push(file.path);
      continue;
    }
    for (const entry of items) {
      if (bytes + cost(entry) > maxBytes) flush();
      bytes += cost(entry);
      if (entry.item.kind === "file") files.push(entry.item.file);
      else blobs.push(entry.item.blob);
    }
    done.push({ path: file.path, part: parts.length });
  }
  flush();
  return { parts, unfit, done };
};

/**
 * The pure packer behind `buildHomeSyncItem`: path-sorted files plus the
 * final extras in, the wire parts out (or null when a composed part would
 * still exceed the frame budget). The budget is injectable so the packing
 * and truncation laws can be proven without production-sized content.
 */
export const packSyncParts = ({
  agentId,
  files,
  finalExtras,
  generation,
  budget = PRODUCTION_SYNC_BUDGET,
}: {
  agentId: string;
  files: HomeFile[];
  finalExtras: SyncFinalExtras;
  generation: number;
  budget?: SyncBudget;
}): SyncPart[] | null => {
  const { maxParts, maxBytes } = budget;
  const { parts, unfit, done } = packFileParts(files, generation, budget);
  for (const path of unfit) {
    log.error({ agentId, path }, "home file can't fit the sync; skipping");
  }

  // Beyond the part cap the sync is TRUNCATED, never refused. Refusing would
  // manufacture exactly the permanently-stuck state this design rejects
  // everywhere else: the composer would fail identically every 60s, forever,
  // and the agent would hold no projection at all. Truncating keeps the first
  // file parts (path-sorted, so deterministic) — the LAST slot is reserved
  // for the extras part — and, critically, narrows the prune manifest to
  // the files that shipped WHOLE (a big file cut between chunks never lands),
  // so the sandbox ends up with a consistent SUBSET rather than a set
  // half-pruned against a manifest it never received. `fitSkillsToSync`
  // leaves skills out before this, so it is logged as an error, not
  // normalized.
  const kept = parts.slice(0, maxParts - 1);
  let prune = finalExtras.prune;
  if (parts.length > maxParts - 1) {
    log.error(
      { agentId, parts: parts.length, cap: maxParts },
      "home sync exceeds the part cap; syncing a truncated set",
    );
    const shipped = new Set(
      done.filter(({ part }) => part < kept.length).map(({ path }) => path),
    );
    prune = prune.filter((path) => shipped.has(path));
  }

  // The dedicated final extras part — appended even when there are zero file
  // parts: an empty manifest prunes the managed roots clean, which is
  // exactly right for an agent whose last skill/memory was deleted.
  const allParts: SyncPart[] = [...kept, { files: [], ...finalExtras, prune }];

  // The sender's own byte check, with the REAL stamps. The wire refine that
  // encodes this rule runs only when the RUNNER parses the poll response —
  // and it throws on the whole response, so one over-budget part would
  // discard every co-batched start, stop, and turn, again every 60s. Nothing
  // in the packer bounds `finalExtras` on its own, so this is the term that
  // makes "we never emit a frame the wire rejects" true rather than implied.
  // Refusing costs this one sandbox a paced retry; sending would cost every
  // other sandbox on the runner its work.
  const oversized = allParts.findIndex(
    (part, index) =>
      partFrameBytes(generation, part, index + 1, allParts.length) > maxBytes,
  );
  if (oversized !== -1) {
    log.error(
      { agentId, part: oversized + 1, of: allParts.length },
      "composed sync part exceeds the frame budget; refusing to emit",
    );
    return null;
  }

  return allParts;
};

/**
 * Compose one sandbox's sync work item: the full desired set, greedily
 * packed into BARE parts whose SERIALIZED supervisor frame stays under
 * MAX_SYNC_PART_BYTES (bytes, not chars — multi-byte content must not slip
 * past the runner WS's silent 256KB drop). The prune manifest and the fresh
 * instruction-render inputs ride a DEDICATED final part appended after
 * packing — decoupling them from the file parts is what makes the per-file
 * deliverability predicate (`memoryFileFitsFrame`) exact: a file that fits a
 * bare frame is always projectable, however large the brief or the manifest
 * grow. The extras part's own budget holds by the authoring caps
 * (instructions ≤20k chars, manifest bounded by the skill/memory count
 * caps) and the library's and tiers' manifest budgets, with
 * `fitSkillsToSync` and the sender's final byte re-check as the braces.
 */
export const buildHomeSyncItem = async (
  agentId: string,
  sandboxId: string,
  generation: number,
  budget: SyncBudget = PRODUCTION_SYNC_BUDGET,
): Promise<RunnerWorkItem | null> => {
  const agent = await loadProjectionAgent(agentId);
  if (!agent) return null;
  const composed = await composeHomeFiles(agentId, agent);

  // ALWAYS present on the final part, empty string meaning "cleared" — an
  // omitted field reads as "unchanged" at the supervisor, which would pin a
  // cleared brief to its old text until the next boot. Same law for the
  // channel presences: an empty array means "none" (a detached presence
  // must leave the doc), omission would mean "unchanged".
  const extras = {
    instructions: agent.instructions ?? "",
    agentName: agent.name ?? "",
    channels: await channelPresencesForRender(agentId),
    peers: await peersForRender(agentId),
    connections: await connectionsForRender(agentId),
  };
  const files = fitSkillsToSync({
    agentId,
    ...composed,
    extras,
    generation,
    budget,
  });
  const finalExtras = { prune: files.map((file) => file.path), ...extras };

  const allParts = packSyncParts({
    agentId,
    files,
    finalExtras,
    generation,
    budget,
  });
  if (!allParts) return null;

  return {
    kind: "skills.changed",
    sandboxId,
    generation,
    parts: allParts,
  };
};
