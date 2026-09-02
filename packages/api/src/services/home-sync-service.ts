import { db } from "@onecli/db";
import {
  MAX_SYNC_PART_BYTES,
  MAX_SYNC_PARTS,
  foldedScalar,
  renderMemoryFile,
  syncFrameByteLength,
  type RunnerWorkItem,
  type HomeSyncFile,
} from "@onecli/agent-protocol";
import { getGatewaySkill } from "../lib/skills/gateway-skill";
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
 * roots must contain, composed at DISPATCH time from current truth — user
 * skills (three tiers, shadow-merged), the builtin gateway skill, and the
 * memory file projection. This module owns the desired-side of the sync
 * clock (the bumps) and the sync item's byte-budgeted part packing; dueness
 * and claims stay in due-work.ts (invariant 15), and the supervisor's
 * materializer owns the writes.
 */

/** Braces on every emitted file: nothing authorable reaches this size (the
 * validations caps sit far under it), so an over-limit file marks a poisoned
 * row — the composer skips its whole skill rather than risk an oversized,
 * silently-dropped frame. */
export const HOME_FILE_MAX_CHARS = 150_000;

const SKILLS_ROOT = ".agents/skills";
const MEMORY_ROOT = "memory";

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

/** The containment braces: the belt (validations) makes a violating path
 * unreachable through any door, so a failure here marks DB tampering or a
 * bug — the file's whole skill is skipped, never thrown (one poisoned row
 * must not brick the agent's sync). */
const isContainedPath = (path: string): boolean => {
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    return false;
  }
  const segments = path.split("/");
  if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) {
    return false;
  }
  // .agents/skills/<name>/references/api.md — root (2) + name + a ≤2-segment
  // file path = 5 segments at the legal maximum.
  if (path.startsWith(`${SKILLS_ROOT}/`)) return segments.length <= 5;
  if (path.startsWith(`${MEMORY_ROOT}/`)) return segments.length <= 2;
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
 * The three tiers a sandbox's agent can see, UNSHADOWED — enabled rows only
 * (a paused row leaves the projection; it never tombstones a broader tier).
 * Projection logic owns this query rather than skill-service to keep the
 * import direction acyclic (skill-service imports the bumps from here).
 */
const listEffectiveSkills = async (
  agentId: string,
  agent: { workspaceId: string; organizationId: string },
): Promise<{
  agent: EffectiveSkill[];
  workspace: EffectiveSkill[];
  organization: EffectiveSkill[];
}> => {
  const select = {
    name: true,
    description: true,
    content: true,
    scope: true,
    files: { select: { path: true, content: true } },
  } as const;
  const [agentRows, workspaceRows, orgRows] = await Promise.all([
    db.skill.findMany({ where: { agentId, enabled: true }, select }),
    db.skill.findMany({
      where: { workspaceId: agent.workspaceId, enabled: true },
      select,
    }),
    db.skill.findMany({
      where: { organizationId: agent.organizationId, enabled: true },
      select,
    }),
  ]);
  return { agent: agentRows, workspace: workspaceRows, organization: orgRows };
};

/** The one agent read the projection needs — every field, once. */
const loadProjectionAgent = async (agentId: string) => {
  const agent = await db.agent.findUnique({
    where: { id: agentId },
    select: {
      workspaceId: true,
      harness: true,
      name: true,
      instructions: true,
      workspace: { select: { organizationId: true } },
    },
  });
  if (!agent) return null;
  return {
    workspaceId: agent.workspaceId,
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
 * (path-sorted). Shadowing: the Map fills organization → workspace → agent, so
 * a later (more specific) tier overwrites a same-named earlier one.
 */
export const buildHomeFileSet = async (
  agentId: string,
  loaded?: ProjectionAgent,
): Promise<HomeFile[]> => {
  const agent = loaded ?? (await loadProjectionAgent(agentId));
  if (!agent) return [];
  const [tiers, memories] = await Promise.all([
    listEffectiveSkills(agentId, agent),
    db.agentMemory.findMany({
      where: { agentId },
      orderBy: { key: "asc" },
      select: { key: true, title: true, description: true, content: true },
    }),
  ]);

  const files: HomeFile[] = [];

  // (a) The builtin gateway skill — byte-identical to /v1/skill/gateway's
  // answer for this harness (not in HOOK_BASED_AGENTS → the broad variant).
  files.push({
    path: `${SKILLS_ROOT}/onecli-gateway/SKILL.md`,
    content: getGatewaySkill(agent.harness ?? undefined),
  });

  // (b) User skills, shadow-merged (agent > workspace > organization).
  const byName = new Map<string, EffectiveSkill>();
  for (const skill of [
    ...tiers.organization,
    ...tiers.workspace,
    ...tiers.agent,
  ]) {
    byName.set(skill.name, skill);
  }
  byName.delete("onecli-gateway"); // braces — the belt refuses it at create
  for (const skill of byName.values()) {
    const skillFiles: HomeFile[] = [
      {
        path: `${SKILLS_ROOT}/${skill.name}/SKILL.md`,
        content: renderSkillMd(skill),
      },
      ...skill.files.map((file) => ({
        path: `${SKILLS_ROOT}/${skill.name}/${file.path}`,
        content: file.content,
      })),
    ];
    const poisoned = skillFiles.find(
      (file) =>
        !isContainedPath(file.path) ||
        file.content.length > HOME_FILE_MAX_CHARS,
    );
    if (poisoned) {
      log.error(
        { agentId, skill: skill.name, path: poisoned.path },
        "skill violates containment; skipping it whole",
      );
      continue;
    }
    files.push(...skillFiles);
  }

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

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
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
 * caps), with the sender's final byte re-check as the brace.
 */
export const buildHomeSyncItem = async (
  agentId: string,
  sandboxId: string,
  generation: number,
): Promise<RunnerWorkItem | null> => {
  const agent = await loadProjectionAgent(agentId);
  if (!agent) return null;
  const files = await buildHomeFileSet(agentId, agent);

  const manifest = files.map((file) => file.path);
  // ALWAYS present on the final part, empty string meaning "cleared" — an
  // omitted field reads as "unchanged" at the supervisor, which would pin a
  // cleared brief to its old text until the next boot.
  const finalExtras = {
    prune: manifest,
    instructions: agent.instructions ?? "",
    agentName: agent.name ?? "",
  };

  // Pack files greedily into bare parts.
  const parts: SyncPart[] = [];
  let current: HomeSyncFile[] = [];
  const flush = () => {
    parts.push({ files: current });
    current = [];
  };
  for (const file of files) {
    const candidate = [...current, file];
    // Measure with WORST-CASE part/of stamps: the real numbers are stamped
    // after packing, and "9"→"17" growing by a digit could tip a
    // razor's-edge part over the budget the wire refine re-checks exactly.
    // MAX_SYNC_PARTS upper-bounds both fields' widths.
    const bytes = partFrameBytes(
      generation,
      { files: candidate },
      MAX_SYNC_PARTS,
      MAX_SYNC_PARTS,
    );
    if (bytes > MAX_SYNC_PART_BYTES && current.length > 0) {
      flush();
      current = [file];
    } else {
      current = candidate;
    }
    // A single file that cannot fit even alone marks a poisoned row the
    // braces above should have caught — skip it, never emit an oversized
    // frame.
    const aloneBytes = partFrameBytes(
      generation,
      { files: current },
      MAX_SYNC_PARTS,
      MAX_SYNC_PARTS,
    );
    if (aloneBytes > MAX_SYNC_PART_BYTES && current.length === 1) {
      log.error(
        { agentId, path: current[0]?.path },
        "home file exceeds a whole sync frame; skipping",
      );
      current = [];
    }
  }
  if (current.length > 0) flush();

  // Beyond the part cap the sync is TRUNCATED, never refused. Refusing would
  // manufacture exactly the permanently-stuck state this design rejects
  // everywhere else: the composer would fail identically every 60s, forever,
  // and the agent would hold no projection at all. Truncating keeps the first
  // file parts (path-sorted, so deterministic) — the LAST slot is reserved
  // for the extras part — and, critically, narrows the prune manifest to
  // what actually ships, so the sandbox ends up with a consistent SUBSET
  // rather than a set half-pruned against a manifest it never received.
  // MAX_SYNC_PARTS is sized so the authoring caps cannot reach here at any
  // encoding, so this is logged as an error, not normalized.
  const kept = parts.slice(0, MAX_SYNC_PARTS - 1);
  if (parts.length > MAX_SYNC_PARTS - 1) {
    log.error(
      { agentId, parts: parts.length, cap: MAX_SYNC_PARTS },
      "home sync exceeds the part cap; syncing a truncated set",
    );
    const shipped = new Set(
      kept.flatMap((part) => part.files.map((file) => file.path)),
    );
    finalExtras.prune = manifest.filter((path) => shipped.has(path));
  }

  // The dedicated final extras part — appended even when there are zero file
  // parts: an empty manifest prunes the managed roots clean, which is
  // exactly right for an agent whose last skill/memory was deleted.
  const allParts: SyncPart[] = [...kept, { files: [], ...finalExtras }];

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
      partFrameBytes(generation, part, index + 1, allParts.length) >
      MAX_SYNC_PART_BYTES,
  );
  if (oversized !== -1) {
    log.error(
      { agentId, part: oversized + 1, of: allParts.length },
      "composed sync part exceeds the frame budget; refusing to emit",
    );
    return null;
  }

  return {
    kind: "skills.changed",
    sandboxId,
    generation,
    parts: allParts,
  };
};
