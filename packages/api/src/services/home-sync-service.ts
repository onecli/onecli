import { db } from "@onecli/db";
import {
  MAX_SYNC_PART_BYTES,
  MAX_SYNC_PARTS,
  foldedScalar,
  homeRelativePathSchema,
  renderMemoryFile,
  syncFrameByteLength,
  type RunnerWorkItem,
  type HomeSyncFile,
} from "@onecli/agent-protocol";
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

/** Braces on every emitted file: nothing authorable reaches this size (the
 * validations caps sit far under it), so an over-limit file marks a poisoned
 * row — the composer skips its whole skill rather than risk an oversized,
 * silently-dropped frame. */
export const HOME_FILE_MAX_CHARS = 150_000;

const SKILLS_ROOT = ".agents/skills";
const MEMORY_ROOT = "memory";

/**
 * The most one agent's library skills may add to the prune manifest the
 * sync's FINAL part carries (every file path, JSON-encoded). Adds and
 * refreshes are refused past it, which keeps a typical agent's final part
 * well inside the frame. Beside a pathological rest-of-agent (every other
 * cap maxed) it can still not fit, so the sync composer measures the real
 * final part and leaves library skills out rather than refuse the sync
 * (`fitLibraryToSync`).
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
 * (`fitLibraryToSync`).
 */
export const LIBRARY_SYNC_BUDGET_BYTES = 60 * MAX_SYNC_PART_BYTES;

/** The manifest bytes one library skill's file paths cost on the final part
 * (each path's JSON string plus its separating comma). */
export const libraryManifestBytes = (name: string, paths: string[]): number =>
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
    `description: ${foldedScalar(skill.description)}`,
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
 * file's path inside the folder. Authored: a ≤2-segment file path
 * (.agents/skills/<name>/references/api.md = 5). Library (from a Git repo):
 * up to LIBRARY_MAX_FILE_DEPTH inside the folder. */
const AUTHORED_SKILL_SEGMENTS = 5;
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
  files: { path: string; content: string }[];
}

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
    files: { select: { path: true, content: true } },
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
  skillFiles: { path: string; content: string }[],
  maxSegments: number,
): HomeFile[] | null => {
  const files = skillFiles.map((file) => ({
    path: `${SKILLS_ROOT}/${name}/${file.path}`,
    content: file.content,
  }));
  const poisoned = files.find(
    (file) =>
      !isContainedPath(file.path, maxSegments) ||
      file.content.length > HOME_FILE_MAX_CHARS,
  );
  if (!poisoned) return files;
  log.error(
    { agentId, skill: name, path: poisoned.path },
    "skill violates containment; skipping it whole",
  );
  return null;
};

/** A library skill in the composed set, and the agent's own same-named skill
 * files it hides (restored if the sync has to leave the library skill out). */
export interface ProjectedLibrarySkill {
  name: string;
  shadows: HomeFile[];
}

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
 * (path-sorted), plus the library skills in it (name order).
 * Shadowing: the Map fills organization → agent, so the agent's own skill
 * overwrites a same-named org skill; a library skill wins over both.
 */
const composeHomeFiles = async (
  agentId: string,
  agent: ProjectionAgent,
): Promise<{ files: HomeFile[]; library: ProjectedLibrarySkill[] }> => {
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
  const library: ProjectedLibrarySkill[] = [];
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
    authored.delete(skill.name);
  }
  for (const skillFiles of authored.values()) files.push(...skillFiles);

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
  return { files, library };
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
export type SyncFinalExtras = Omit<SyncPart, "files"> & { prune: string[] };

/**
 * The home files minus as many library skills (last by name first) as it
 * takes for the sync to carry everything else: the final part, manifest
 * included, fits the frame, and the file parts fit the part cap, so the
 * packer's truncation never reaches an authored or memory file. A left-out
 * library skill gives its name back to the agent's own skill it shadowed. A
 * library has no authoring cap tight enough to prove the fit on its own, and
 * it must never be the reason a sync is refused or cut short: leaving one
 * out costs one skill. The per-agent budgets keep agents far from this, so
 * it is logged as an error, never expected.
 */
export const fitLibraryToSync = ({
  agentId,
  files,
  library,
  extras,
  generation,
  budget = PRODUCTION_SYNC_BUDGET,
}: {
  agentId: string;
  files: HomeFile[];
  library: ProjectedLibrarySkill[];
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
  for (const skill of [...library].reverse()) {
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
      "home sync over budget; leaving library skills out",
    );
  }
  return kept;
};

/**
 * Greedy packing of path-sorted files into BARE parts, measured with
 * WORST-CASE part/of stamps: the real numbers are stamped after packing, and
 * "9"→"17" growing by a digit could tip a razor's-edge part over the budget
 * the wire refine re-checks exactly. The part cap upper-bounds both fields'
 * widths. A part's size is kept as a running sum, exact because a JSON
 * array's bytes are its items' bytes plus one comma between each (so a
 * library of thousands of files packs in one pass, not by re-serializing the
 * growing part per file). A single file that can't fit even alone marks a
 * poisoned row the braces should have caught: it is skipped (and named),
 * never emitted.
 */
const packFileParts = (
  files: HomeSyncFile[],
  generation: number,
  { maxParts, maxBytes }: SyncBudget,
): { parts: SyncPart[]; oversized: string[] } => {
  const empty = partFrameBytes(generation, { files: [] }, maxParts, maxParts);
  const parts: SyncPart[] = [];
  const oversized: string[] = [];
  let current: HomeSyncFile[] = [];
  let bytes = empty;
  for (const file of files) {
    const item = syncFrameByteLength(file);
    if (current.length > 0 && bytes + 1 + item > maxBytes) {
      parts.push({ files: current });
      current = [];
      bytes = empty;
    }
    if (current.length === 0 && empty + item > maxBytes) {
      oversized.push(file.path);
      continue;
    }
    bytes += (current.length > 0 ? 1 : 0) + item;
    current.push(file);
  }
  if (current.length > 0) parts.push({ files: current });
  return { parts, oversized };
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
  files: HomeSyncFile[];
  finalExtras: SyncFinalExtras;
  generation: number;
  budget?: SyncBudget;
}): SyncPart[] | null => {
  const { maxParts, maxBytes } = budget;
  const extras: SyncFinalExtras = { ...finalExtras };
  const { parts, oversized: unfit } = packFileParts(files, generation, budget);
  for (const path of unfit) {
    log.error(
      { agentId, path },
      "home file exceeds a whole sync frame; skipping",
    );
  }

  // Beyond the part cap the sync is TRUNCATED, never refused. Refusing would
  // manufacture exactly the permanently-stuck state this design rejects
  // everywhere else: the composer would fail identically every 60s, forever,
  // and the agent would hold no projection at all. Truncating keeps the first
  // file parts (path-sorted, so deterministic) — the LAST slot is reserved
  // for the extras part — and, critically, narrows the prune manifest to
  // what actually ships, so the sandbox ends up with a consistent SUBSET
  // rather than a set half-pruned against a manifest it never received.
  // MAX_SYNC_PARTS is sized so the authoring caps cannot reach here at any
  // encoding, and `fitLibraryToSync` leaves library skills out first, so
  // this is logged as an error, not normalized.
  const kept = parts.slice(0, maxParts - 1);
  if (parts.length > maxParts - 1) {
    log.error(
      { agentId, parts: parts.length, cap: maxParts },
      "home sync exceeds the part cap; syncing a truncated set",
    );
    const shipped = new Set(
      kept.flatMap((part) => part.files.map((file) => file.path)),
    );
    extras.prune = finalExtras.prune.filter((path) => shipped.has(path));
  }

  // The dedicated final extras part — appended even when there are zero file
  // parts: an empty manifest prunes the managed roots clean, which is
  // exactly right for an agent whose last skill/memory was deleted.
  const allParts: SyncPart[] = [...kept, { files: [], ...extras }];

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
 * caps) and the library's per-agent budgets, with `fitLibraryToSync` and the
 * sender's final byte re-check as the braces.
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
  const files = fitLibraryToSync({
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
