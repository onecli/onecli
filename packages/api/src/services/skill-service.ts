import { db, Prisma } from "@onecli/db";
import { ServiceError } from "./errors";
import {
  MAX_FILES_PER_SKILL,
  MAX_IMPORTED_SKILL_FILES,
  MAX_SKILL_TOTAL_CHARS,
  MAX_SKILLS_PER_AGENT,
  MAX_SKILLS_PER_ORG,
  SKILL_CONTENT_MAX_LENGTH,
  SKILL_FILE_CONTENT_MAX_LENGTH,
  SKILL_TIER_BUDGETS,
  cleanSkillDescription,
  skillPathClashes,
  type SkillScope,
} from "../validations/skills";
import {
  bumpHomeForAgent,
  bumpHomeForOrganization,
  skillManifestBytes,
} from "./home-sync-service";
import { summarizeSkillFiles, type ImportedSkill } from "./skill-import";

/**
 * User-authored skills (plans/hosted-agents-v2.md step 9, §3.7/§3.8).
 *
 * Truth lives here; sandboxes hold a regenerated read-only projection.
 * Two tiers with exactly one owner column each (the migration CHECKs): an
 * agent's own skills and the organization's. The same name at both tiers is
 * legal: the composer materializes the agent's own. Scope logic is
 * deliberately skill-local (the memory precedent): resource-scope.ts is a
 * workspace/org helper for other resources and stays untouched.
 *
 * Every write ends with the tier-matched home bump so RUNNING sandboxes
 * re-materialize within seconds; parked ones pick the change up at next boot.
 */

const skillListSelect = {
  id: true,
  scope: true,
  agentId: true,
  organizationId: true,
  name: true,
  description: true,
  enabled: true,
  createdByEmail: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { files: true } },
} as const;

const skillDetailSelect = {
  id: true,
  scope: true,
  agentId: true,
  organizationId: true,
  name: true,
  description: true,
  content: true,
  enabled: true,
  createdByEmail: true,
  createdAt: true,
  updatedAt: true,
  files: {
    orderBy: { path: "asc" as const },
    select: { path: true, content: true, data: true, executable: true },
  },
} as const;

export type SkillListItem = {
  id: string;
  scope: string;
  agentId: string | null;
  organizationId: string | null;
  name: string;
  description: string;
  enabled: boolean;
  createdByEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
  fileCount: number;
};

/** One file of a skill as the dashboard reads it. A file the hand-written
 * editor can't show or save as it is (binary, runnable, or larger than the
 * editor's cap) comes back with empty `content` and `editable: false`: its
 * bytes stay server-side, and a save keeps it. */
export interface SkillFileView {
  path: string;
  content: string;
  bytes: number;
  binary: boolean;
  executable: boolean;
  editable: boolean;
}

export type SkillView = Omit<SkillListItem, "fileCount"> & {
  content: string;
  files: SkillFileView[];
};

type SkillFileRow = {
  path: string;
  content: string;
  data: Uint8Array | null;
  executable: boolean;
};

type SkillRow = Omit<SkillView, "files"> & { files: SkillFileRow[] };

/** The one rule for which files the hand-written editor owns: plain text
 * it can show and save back unchanged (a runnable flag it can't show would
 * be lost on save). The view and the patch both use it. */
const fitsEditor = (file: SkillFileRow): boolean =>
  file.data === null &&
  !file.executable &&
  file.content.length <= SKILL_FILE_CONTENT_MAX_LENGTH;

const toView = (row: SkillRow): SkillView => ({
  ...row,
  // Read clean too: rows stored before every door cleaned show as one line.
  description: cleanSkillDescription(row.description),
  files: row.files.map((file) => {
    const editable = fitsEditor(file);
    return {
      path: file.path,
      content: editable ? file.content : "",
      bytes: file.data ? file.data.byteLength : Buffer.byteLength(file.content),
      binary: file.data !== null,
      executable: file.executable,
      editable,
    };
  }),
});

export interface SkillFileInput {
  path: string;
  content: string;
}

export interface SkillInput {
  name: string;
  description: string;
  content: string;
  enabled?: boolean;
  files?: SkillFileInput[];
}

export interface SkillPatch {
  description?: string;
  content?: string;
  enabled?: boolean;
  files?: SkillFileInput[];
}

/** Who authored the write — denormalized email survives user deletion. */
export interface SkillCreator {
  userId: string | null;
  email: string | null;
}

const toListItem = (
  row: Omit<SkillListItem, "fileCount"> & { _count: { files: number } },
): SkillListItem => {
  const { _count, ...rest } = row;
  return {
    ...rest,
    description: cleanSkillDescription(rest.description),
    fileCount: _count.files,
  };
};

/** The agent fence the agent tier shares with crons/memory. */
const requireHostedAgent = async (workspaceId: string, agentId: string) => {
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
  return agent;
};

/** The visibility fence for the workspace door: a skill is visible when it
 * can REACH this workspace: the org's rows and the workspace's agents'
 * rows. */
const workspaceVisibleWhere = (
  workspaceId: string,
  organizationId: string,
): Prisma.SkillWhereInput => ({
  OR: [{ organizationId }, { agent: { workspaceId } }],
});

export const listSkillsForWorkspace = async (
  workspaceId: string,
  organizationId: string,
): Promise<SkillListItem[]> => {
  const rows = await db.skill.findMany({
    where: workspaceVisibleWhere(workspaceId, organizationId),
    orderBy: [{ scope: "asc" }, { name: "asc" }],
    select: skillListSelect,
  });
  return rows.map(toListItem);
};

export const getSkill = async (
  workspaceId: string,
  organizationId: string,
  skillId: string,
): Promise<SkillView> => {
  // Fenced read: existence is decided by visibility, so a foreign skill id
  // reads as NOT_FOUND, never as a hint.
  const skill = await db.skill.findFirst({
    where: {
      id: skillId,
      ...workspaceVisibleWhere(workspaceId, organizationId),
    },
    select: skillDetailSelect,
  });
  if (!skill) throw new ServiceError("NOT_FOUND", "Skill not found");
  return toView(skill);
};

const capMessageFor = (scope: SkillScope): string => {
  switch (scope) {
    case "agent":
      return `This agent already holds ${MAX_SKILLS_PER_AGENT} skills. Delete one first`;
    case "organization":
      return `This organization already holds ${MAX_SKILLS_PER_ORG} skills. Delete one first`;
  }
};

type SkillOwner = { agentId: string } | { organizationId: string };

const ownerKey = (owner: SkillOwner): string =>
  "agentId" in owner
    ? `agent:${owner.agentId}`
    : `organization:${owner.organizationId}`;

/** Serializes skill writes per owner, so two concurrent creates or imports
 * can't both pass the count cap or the tier budgets. */
const lockOwner = (tx: Prisma.TransactionClient, owner: SkillOwner) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`skills:${ownerKey(owner)}`}))`;

const assertTierCap = async (
  tx: Prisma.TransactionClient,
  scope: SkillScope,
  owner: SkillOwner,
): Promise<void> => {
  const max = scope === "agent" ? MAX_SKILLS_PER_AGENT : MAX_SKILLS_PER_ORG;
  const held = await tx.skill.count({ where: owner });
  if (held >= max) {
    throw new ServiceError("UNPROCESSABLE", capMessageFor(scope));
  }
};

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

const duplicateNameError = (name: string) =>
  new ServiceError("CONFLICT", `A skill named "${name}" already exists here`);

const createRow = async (
  scope: SkillScope,
  owner: SkillOwner,
  input: SkillInput,
  creator: SkillCreator,
): Promise<SkillView> => {
  try {
    const created = await db.$transaction(async (tx) => {
      await lockOwner(tx, owner);
      await assertTierCap(tx, scope, owner);
      return tx.skill.create({
        data: {
          scope,
          ...owner,
          name: input.name,
          description: input.description,
          content: input.content,
          enabled: input.enabled ?? true,
          createdByUserId: creator.userId,
          createdByEmail: creator.email,
          ...(input.files?.length && {
            files: { create: input.files.map((f) => ({ ...f })) },
          }),
        },
        select: skillDetailSelect,
      });
    });
    return toView(created);
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicateNameError(input.name);
    throw err;
  }
};

/** The workspace door's create: always an agent's own skill, for a hosted
 * agent of THIS workspace (the fence). */
export const createSkill = async (
  workspaceId: string,
  input: SkillInput & { agentId: string },
  creator: SkillCreator,
): Promise<SkillView> => {
  await requireHostedAgent(workspaceId, input.agentId);
  const skill = await createRow(
    "agent",
    { agentId: input.agentId },
    input,
    creator,
  );
  await bumpHomeForAgent(input.agentId);
  return skill;
};

export const createOrgSkill = async (
  organizationId: string,
  input: SkillInput,
  creator: SkillCreator,
): Promise<SkillView> => {
  const skill = await createRow(
    "organization",
    { organizationId },
    input,
    creator,
  );
  await bumpHomeForOrganization(organizationId);
  return skill;
};

/** One imported skill as saved: what the person and the agent are told.
 * `id` is the saved row (the same one when a name was replaced). */
export interface ImportedSkillOutcome {
  id: string;
  name: string;
  description: string;
  files: number;
  bytes: number;
  groups: Record<string, number>;
  skipped: { path: string; reason: string }[];
  replaced: boolean;
}

const MB = 1024 * 1024;

/** What one held skill costs its tier, measured in the database: its body
 * and file bytes, and the manifest its file paths put on the sync. */
const heldSkills = async (tx: Prisma.TransactionClient, owner: SkillOwner) => {
  const rows = await tx.$queryRaw<
    { id: string; name: string; bytes: bigint; paths: string[] }[]
  >`
    SELECT s.id, s.name,
      octet_length(s.content)
        + COALESCE(SUM(COALESCE(octet_length(f.data), octet_length(f.content))), 0)
        AS bytes,
      COALESCE(array_agg(f.path) FILTER (WHERE f.path IS NOT NULL), '{}') AS paths
    FROM skills s LEFT JOIN skill_files f ON f.skill_id = s.id
    WHERE ${
      "agentId" in owner
        ? Prisma.sql`s.agent_id = ${owner.agentId}`
        : Prisma.sql`s.organization_id = ${owner.organizationId}`
    }
    GROUP BY s.id`;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    bytes: Number(row.bytes),
    manifestBytes: skillManifestBytes(row.name, ["SKILL.md", ...row.paths]),
  }));
};

/**
 * Save skills read from a zip (`importSkillZip`) for one owner, all or
 * nothing: one transaction, serialized per owner, so the count cap and the
 * tier budgets (SKILL_TIER_BUDGETS) hold under concurrent imports. A name
 * the owner already holds is REPLACED (re-uploading a fixed zip is the
 * normal way to update it); a new name counts against the cap. One home
 * bump for the owner after, and none when there is nothing to save.
 */
const saveImportedSkills = async (
  scope: SkillScope,
  owner: SkillOwner,
  skills: ImportedSkill[],
  creator: SkillCreator,
): Promise<ImportedSkillOutcome[]> => {
  if (skills.length === 0) return [];
  const budget = SKILL_TIER_BUDGETS[scope];
  // The owner lock makes every name read below current, so each name either
  // exists (replaced) or is free (created): no unique-violation race.
  const saved = await db.$transaction(
    async (tx) => {
      await lockOwner(tx, owner);
      const held = await heldSkills(tx, owner);
      const importing = new Set(skills.map((s) => s.name));
      const kept = held.filter((s) => !importing.has(s.name));
      const max = scope === "agent" ? MAX_SKILLS_PER_AGENT : MAX_SKILLS_PER_ORG;
      if (kept.length + skills.length > max) {
        throw new ServiceError("UNPROCESSABLE", capMessageFor(scope));
      }
      const bytes =
        kept.reduce((sum, s) => sum + s.bytes, 0) +
        skills.reduce((sum, s) => sum + s.bytes, 0);
      if (bytes > budget.bytes) {
        throw new ServiceError(
          "UNPROCESSABLE",
          `Skills here are limited to ${budget.bytes / MB} MB together, and this would make ${(bytes / MB).toFixed(1)} MB. Remove a skill or some files first`,
        );
      }
      const manifest =
        kept.reduce((sum, s) => sum + s.manifestBytes, 0) +
        skills.reduce(
          (sum, s) =>
            sum +
            skillManifestBytes(s.name, [
              "SKILL.md",
              ...s.files.map((f) => f.path),
            ]),
          0,
        );
      if (manifest > budget.manifestBytes) {
        throw new ServiceError(
          "UNPROCESSABLE",
          "Skills here would hold too many files together. Remove a skill or some files first",
        );
      }

      const prior = new Map(held.map((s) => [s.name, s.id]));
      const outcomes: ImportedSkillOutcome[] = [];
      for (const skill of skills) {
        const files = skill.files.map((file) => ({
          path: file.path,
          content: file.content,
          data: file.data ? new Uint8Array(file.data) : null,
          executable: file.executable,
        }));
        const outcome = (id: string, replaced: boolean) => ({
          id,
          name: skill.name,
          description: skill.description,
          files: skill.files.length + 1,
          bytes: skill.bytes,
          groups: summarizeSkillFiles(skill.files),
          skipped: skill.skipped,
          replaced,
        });
        const priorId = prior.get(skill.name);
        if (priorId) {
          await tx.skillFile.deleteMany({ where: { skillId: priorId } });
          await tx.skill.update({
            where: { id: priorId },
            data: {
              description: skill.description,
              content: skill.content,
              files: { create: files },
            },
          });
          outcomes.push(outcome(priorId, true));
          continue;
        }
        const created = await tx.skill.create({
          data: {
            scope,
            ...owner,
            name: skill.name,
            description: skill.description,
            content: skill.content,
            createdByUserId: creator.userId,
            createdByEmail: creator.email,
            files: { create: files },
          },
          select: { id: true },
        });
        outcomes.push(outcome(created.id, false));
      }
      return outcomes;
    },
    { maxWait: 10_000, timeout: 30_000 },
  );

  if ("agentId" in owner) await bumpHomeForAgent(owner.agentId);
  else await bumpHomeForOrganization(owner.organizationId);
  return saved;
};

/** Import skills from a zip into one hosted agent of this workspace. */
export const importAgentSkills = async (
  workspaceId: string,
  agentId: string,
  skills: ImportedSkill[],
  creator: SkillCreator,
): Promise<ImportedSkillOutcome[]> => {
  await requireHostedAgent(workspaceId, agentId);
  return saveImportedSkills("agent", { agentId }, skills, creator);
};

/** Import skills from a zip into the organization tier. */
export const importOrgSkills = (
  organizationId: string,
  skills: ImportedSkill[],
  creator: SkillCreator,
): Promise<ImportedSkillOutcome[]> =>
  saveImportedSkills("organization", { organizationId }, skills, creator);

/** The write fence for the workspace door: org rows are member-VISIBLE here
 * but managed at org level — a same-tenant role denial is FORBIDDEN with a
 * pointer, never a hint-free 404 (that is for cross-tenant — which is why
 * the org arm is scoped to the CALLER'S org, not `not: null`). */
const requireWorkspaceWritableSkill = async (
  workspaceId: string,
  organizationId: string,
  skillId: string,
) => {
  const skill = await db.skill.findFirst({
    where: {
      id: skillId,
      OR: [{ agent: { workspaceId } }, { organizationId }],
    },
    select: {
      id: true,
      agentId: true,
      content: true,
      enabled: true,
      description: true,
      files: {
        select: { path: true, content: true, data: true, executable: true },
      },
    },
  });
  if (!skill) throw new ServiceError("NOT_FOUND", "Skill not found");
  // The fence admits agent rows and the caller's org rows; anything without
  // an agent is an org row, managed at org level.
  const { agentId } = skill;
  if (!agentId) {
    throw new ServiceError(
      "FORBIDDEN",
      "Organization skills are managed in organization settings",
    );
  }
  return { ...skill, agentId };
};

const applyPatch = async (
  skillId: string,
  existing: {
    description: string;
    content: string;
    enabled: boolean;
    files: SkillFileRow[];
  },
  patch: SkillPatch,
): Promise<SkillView | null> => {
  // An imported skill: files the hand-written editor can't hold whole (one
  // `fitsEditor` refuses, or more than it takes), or a body imported past
  // its limit. Its patch files replace their own paths and every other file
  // is KEPT, so saving a description never wipes the folder; re-uploading
  // the zip is how its files change. Any other skill's files are replaced
  // whole, under the hand-written limits.
  const imported =
    existing.files.length > MAX_FILES_PER_SKILL ||
    existing.files.some((file) => !fitsEditor(file)) ||
    existing.content.length > SKILL_CONTENT_MAX_LENGTH;
  // An imported body may be edited but never grow.
  const contentLimit = Math.max(
    SKILL_CONTENT_MAX_LENGTH,
    existing.content.length,
  );
  if (patch.content !== undefined && patch.content.length > contentLimit) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `Instructions are limited to ${contentLimit.toLocaleString("en-US")} characters`,
    );
  }
  const patchFiles = patch.files;
  const kept =
    patchFiles === undefined || !imported
      ? []
      : existing.files.filter(
          (file) => !patchFiles.some((p) => p.path === file.path),
        );
  if (
    patchFiles !== undefined &&
    kept.length + patchFiles.length > MAX_IMPORTED_SKILL_FILES - 1
  ) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `A skill holds at most ${MAX_IMPORTED_SKILL_FILES} files, SKILL.md included`,
    );
  }
  if (patchFiles !== undefined) {
    // The editor never sees kept files, so its own paths must not clash
    // with theirs (a file where a kept folder is, or the reverse).
    const taken = new Set(kept.map((file) => file.path.toLowerCase()));
    const clash = patchFiles.find((file) => {
      const clashes = skillPathClashes(file.path, taken);
      taken.add(file.path.toLowerCase());
      return clashes;
    });
    if (clash) {
      throw new ServiceError(
        "UNPROCESSABLE",
        `"${clash.path}" clashes with a file this skill already holds`,
      );
    }
  }
  const nextFiles = patch.files ?? existing.files;
  const nextContent = patch.content ?? existing.content;
  // The merged-row budget re-check guards hand-written skills; an imported
  // folder is bounded by the import limits instead.
  const total =
    nextContent.length +
    nextFiles.reduce((sum, file) => sum + file.content.length, 0);
  if (!imported && total > MAX_SKILL_TOTAL_CHARS) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `A skill's body and files together are limited to ${MAX_SKILL_TOTAL_CHARS.toLocaleString("en-US")} characters`,
    );
  }

  const noOp =
    (patch.description === undefined ||
      patch.description === existing.description) &&
    (patch.content === undefined || patch.content === existing.content) &&
    (patch.enabled === undefined || patch.enabled === existing.enabled) &&
    (patch.files === undefined ||
      (patch.files.every((file) =>
        existing.files.some(
          (own) => own.path === file.path && own.content === file.content,
        ),
      ) &&
        patch.files.length + kept.length === existing.files.length));
  if (noOp) return null;

  const updated = await db.$transaction(async (tx) => {
    if (patch.files !== undefined) {
      // Replace what the editor owns; keep what it never showed.
      const keepPaths = kept.map((file) => file.path);
      await tx.skillFile.deleteMany({
        where: { skillId, path: { notIn: keepPaths } },
      });
      if (patch.files.length > 0) {
        await tx.skillFile.createMany({
          data: patch.files.map((file) => ({ skillId, ...file })),
        });
      }
    }
    return tx.skill.update({
      where: { id: skillId },
      data: {
        ...(patch.description !== undefined && {
          description: patch.description,
        }),
        ...(patch.content !== undefined && { content: patch.content }),
        ...(patch.enabled !== undefined && { enabled: patch.enabled }),
      },
      select: skillDetailSelect,
    });
  });
  return toView(updated);
};

export const updateSkill = async (
  workspaceId: string,
  organizationId: string,
  skillId: string,
  patch: SkillPatch,
): Promise<SkillView> => {
  const existing = await requireWorkspaceWritableSkill(
    workspaceId,
    organizationId,
    skillId,
  );
  const updated = await applyPatch(skillId, existing, patch);
  if (!updated) {
    // No-op: return current state without a bump (the modelChanged posture —
    // a settings form re-sending stored values must cost nothing).
    return getSkillById(skillId);
  }
  await bumpHomeForAgent(existing.agentId);
  return updated;
};

export const deleteSkill = async (
  workspaceId: string,
  organizationId: string,
  skillId: string,
): Promise<void> => {
  const existing = await requireWorkspaceWritableSkill(
    workspaceId,
    organizationId,
    skillId,
  );
  await db.skill.delete({ where: { id: existing.id } });
  await bumpHomeForAgent(existing.agentId);
};

const getSkillById = async (skillId: string): Promise<SkillView> => {
  // Not `findUniqueOrThrow`: this runs on the no-op-PATCH path AFTER the
  // fence has already passed, so a concurrent delete is a plain 404, not a
  // raw Prisma error surfacing as a 500.
  const skill = await db.skill.findUnique({
    where: { id: skillId },
    select: skillDetailSelect,
  });
  if (!skill) throw new ServiceError("NOT_FOUND", "Skill not found");
  return toView(skill);
};

// ── The agent door (the skill_* MCP tools) ──────────────────────────────────
// Writes are fenced to the AGENT TIER: a sandbox write must never change what
// other agents load, so org rows — member-visible, human-managed — answer
// FORBIDDEN with a dashboard pointer, and a name that exists nowhere visible
// answers NOT_FOUND. Reads see both tiers (the same set the composer
// materializes, minus the shadow-merge — the agent needs to know what exists
// and which rows are its own).

/** Both tiers that reach this agent, flat, scope marked — enabled and
 * disabled alike (an agent must see its own paused rows to re-enable them). */
export const listSkillsReachingAgent = async (
  agentId: string,
  organizationId: string,
): Promise<SkillListItem[]> => {
  const rows = await db.skill.findMany({
    where: { OR: [{ agentId }, { organizationId }] },
    orderBy: [{ scope: "asc" }, { name: "asc" }],
    select: skillListSelect,
  });
  return rows.map(toListItem);
};

/** The write fence for the agent door: the agent's OWN row by name, or the
 * honest refusal. An org row with that name is FORBIDDEN with a pointer (the
 * requireWorkspaceWritableSkill posture); an unknown name is NOT_FOUND. */
const requireAgentOwnSkill = async (
  agentId: string,
  organizationId: string,
  name: string,
) => {
  const own = await db.skill.findFirst({
    where: { agentId, name },
    select: {
      id: true,
      description: true,
      content: true,
      enabled: true,
      files: {
        select: { path: true, content: true, data: true, executable: true },
      },
    },
  });
  if (own) return own;
  const orgRow = await db.skill.findFirst({
    where: { name, organizationId },
    select: { id: true },
  });
  if (orgRow) {
    throw new ServiceError(
      "FORBIDDEN",
      `"${name}" is an organization skill, managed by the people you work with in the dashboard. You can only change your own agent skills. You can also create an agent skill with this name, which takes precedence for you.`,
    );
  }
  throw new ServiceError(
    "NOT_FOUND",
    `You hold no agent skill named "${name}". skill_list shows what exists`,
  );
};

export const updateAgentSkillByName = async (
  agentId: string,
  organizationId: string,
  name: string,
  patch: SkillPatch,
): Promise<{ skill: SkillView; noop: boolean }> => {
  const existing = await requireAgentOwnSkill(agentId, organizationId, name);
  const updated = await applyPatch(existing.id, existing, patch);
  if (!updated) return { skill: await getSkillById(existing.id), noop: true };
  await bumpHomeForAgent(agentId);
  return { skill: updated, noop: false };
};

export const deleteAgentSkillByName = async (
  agentId: string,
  organizationId: string,
  name: string,
): Promise<{ id: string }> => {
  const existing = await requireAgentOwnSkill(agentId, organizationId, name);
  await db.skill.delete({ where: { id: existing.id } });
  await bumpHomeForAgent(agentId);
  return { id: existing.id };
};

// ── The org door ────────────────────────────────────────────────────────────

export const listOrgSkills = async (
  organizationId: string,
): Promise<SkillListItem[]> => {
  const rows = await db.skill.findMany({
    where: { organizationId },
    orderBy: { name: "asc" },
    select: skillListSelect,
  });
  return rows.map(toListItem);
};

const requireOrgSkill = async (organizationId: string, skillId: string) => {
  const skill = await db.skill.findFirst({
    where: { id: skillId, organizationId },
    select: {
      id: true,
      description: true,
      content: true,
      enabled: true,
      files: {
        select: { path: true, content: true, data: true, executable: true },
      },
    },
  });
  if (!skill) throw new ServiceError("NOT_FOUND", "Skill not found");
  return skill;
};

export const getOrgSkill = async (
  organizationId: string,
  skillId: string,
): Promise<SkillView> => {
  const skill = await db.skill.findFirst({
    where: { id: skillId, organizationId },
    select: skillDetailSelect,
  });
  if (!skill) throw new ServiceError("NOT_FOUND", "Skill not found");
  return toView(skill);
};

export const updateOrgSkill = async (
  organizationId: string,
  skillId: string,
  patch: SkillPatch,
): Promise<SkillView> => {
  const existing = await requireOrgSkill(organizationId, skillId);
  const updated = await applyPatch(skillId, existing, patch);
  if (!updated) return getSkillById(skillId);
  await bumpHomeForOrganization(organizationId);
  return updated;
};

export const deleteOrgSkill = async (
  organizationId: string,
  skillId: string,
): Promise<void> => {
  const existing = await requireOrgSkill(organizationId, skillId);
  await db.skill.delete({ where: { id: existing.id } });
  await bumpHomeForOrganization(organizationId);
};
