import { db, Prisma } from "@onecli/db";
import { ServiceError } from "./errors";
import {
  MAX_SKILL_TOTAL_CHARS,
  MAX_SKILLS_PER_AGENT,
  MAX_SKILLS_PER_ORG,
  MAX_SKILLS_PER_WORKSPACE,
  type SkillScope,
} from "../validations/skills";
import {
  bumpHomeForAgent,
  bumpHomeForOrganization,
  bumpHomeForWorkspace,
} from "./home-sync-service";

/**
 * User-authored skills (plans/hosted-agents-v2.md step 9, §3.7/§3.8).
 *
 * Truth lives here; sandboxes hold a regenerated read-only projection.
 * Three tiers with exactly one owner column each (the migration CHECKs);
 * the same name at different tiers is legal — the composer materializes the
 * most specific one. Scope logic is deliberately skill-local (the memory
 * precedent): resource-scope.ts is a two-tier helper and stays untouched.
 *
 * Every write ends with the tier-matched home bump so RUNNING sandboxes
 * re-materialize within seconds; parked ones pick the change up at next boot.
 */

const skillListSelect = {
  id: true,
  scope: true,
  agentId: true,
  workspaceId: true,
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
  workspaceId: true,
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
    select: { path: true, content: true },
  },
} as const;

export type SkillListItem = {
  id: string;
  scope: string;
  agentId: string | null;
  workspaceId: string | null;
  organizationId: string | null;
  name: string;
  description: string;
  enabled: boolean;
  createdByEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
  fileCount: number;
};

export type SkillView = Omit<SkillListItem, "fileCount"> & {
  content: string;
  files: { path: string; content: string }[];
};

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
  return { ...rest, fileCount: _count.files };
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

/** The three-tier visibility fence for the workspace door: a skill is visible
 * when it can REACH this workspace — its own rows, the org's rows, and the
 * workspace's agents' rows. */
const workspaceVisibleWhere = (
  workspaceId: string,
  organizationId: string,
): Prisma.SkillWhereInput => ({
  OR: [{ workspaceId }, { organizationId }, { agent: { workspaceId } }],
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
  return skill;
};

const capMessageFor = (scope: SkillScope): string => {
  switch (scope) {
    case "agent":
      return `This agent already holds ${MAX_SKILLS_PER_AGENT} skills. Delete one first`;
    case "workspace":
      return `This workspace already holds ${MAX_SKILLS_PER_WORKSPACE} skills. Delete one first`;
    case "organization":
      return `This organization already holds ${MAX_SKILLS_PER_ORG} skills. Delete one first`;
  }
};

const assertTierCap = async (
  scope: SkillScope,
  ownerId: string,
): Promise<void> => {
  const where =
    scope === "agent"
      ? { agentId: ownerId }
      : scope === "workspace"
        ? { workspaceId: ownerId }
        : { organizationId: ownerId };
  const max =
    scope === "agent"
      ? MAX_SKILLS_PER_AGENT
      : scope === "workspace"
        ? MAX_SKILLS_PER_WORKSPACE
        : MAX_SKILLS_PER_ORG;
  const held = await db.skill.count({ where });
  if (held >= max) {
    throw new ServiceError("UNPROCESSABLE", capMessageFor(scope));
  }
};

const duplicateNameError = (name: string) =>
  new ServiceError("CONFLICT", `A skill named "${name}" already exists here`);

const createRow = async (
  scope: SkillScope,
  owner: { agentId?: string; workspaceId?: string; organizationId?: string },
  input: SkillInput,
  creator: SkillCreator,
): Promise<SkillView> => {
  try {
    return await db.skill.create({
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
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw duplicateNameError(input.name);
    }
    throw err;
  }
};

/** The workspace door's create: workspace tier, or agent tier when agentId is
 * given (a hosted agent of THIS workspace — the fence). */
export const createSkill = async (
  workspaceId: string,
  input: SkillInput & { agentId?: string },
  creator: SkillCreator,
): Promise<SkillView> => {
  if (input.agentId) {
    await requireHostedAgent(workspaceId, input.agentId);
    await assertTierCap("agent", input.agentId);
    const skill = await createRow(
      "agent",
      { agentId: input.agentId },
      input,
      creator,
    );
    await bumpHomeForAgent(input.agentId);
    return skill;
  }
  await assertTierCap("workspace", workspaceId);
  const skill = await createRow("workspace", { workspaceId }, input, creator);
  await bumpHomeForWorkspace(workspaceId);
  return skill;
};

export const createOrgSkill = async (
  organizationId: string,
  input: SkillInput,
  creator: SkillCreator,
): Promise<SkillView> => {
  await assertTierCap("organization", organizationId);
  const skill = await createRow(
    "organization",
    { organizationId },
    input,
    creator,
  );
  await bumpHomeForOrganization(organizationId);
  return skill;
};

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
      OR: [{ workspaceId }, { agent: { workspaceId } }, { organizationId }],
    },
    select: {
      id: true,
      scope: true,
      agentId: true,
      workspaceId: true,
      organizationId: true,
      content: true,
      enabled: true,
      description: true,
      files: { select: { path: true, content: true } },
    },
  });
  if (!skill) throw new ServiceError("NOT_FOUND", "Skill not found");
  if (skill.organizationId) {
    throw new ServiceError(
      "FORBIDDEN",
      "Organization skills are managed in organization settings",
    );
  }
  return skill;
};

const bumpForRow = async (row: {
  agentId: string | null;
  workspaceId: string | null;
  organizationId: string | null;
}): Promise<void> => {
  if (row.agentId) return bumpHomeForAgent(row.agentId);
  if (row.workspaceId) return bumpHomeForWorkspace(row.workspaceId);
  if (row.organizationId) return bumpHomeForOrganization(row.organizationId);
};

const applyPatch = async (
  skillId: string,
  existing: {
    description: string;
    content: string;
    enabled: boolean;
    files: { path: string; content: string }[];
  },
  patch: SkillPatch,
): Promise<SkillView | null> => {
  const nextFiles = patch.files ?? existing.files;
  const nextContent = patch.content ?? existing.content;
  // The merged-row budget re-check: a content-only PATCH must not smuggle
  // the sum over the cap the create door enforced.
  const total =
    nextContent.length +
    nextFiles.reduce((sum, file) => sum + file.content.length, 0);
  if (total > MAX_SKILL_TOTAL_CHARS) {
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
      (patch.files.length === existing.files.length &&
        patch.files.every((file) =>
          existing.files.some(
            (own) => own.path === file.path && own.content === file.content,
          ),
        )));
  if (noOp) return null;

  return db.$transaction(async (tx) => {
    if (patch.files !== undefined) {
      // Full replacement — the payload is small and capped; partial file
      // surgery would add four endpoints to save nothing.
      await tx.skillFile.deleteMany({ where: { skillId } });
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
  await bumpForRow(existing);
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
  await bumpForRow(existing);
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
  return skill;
};

// ── The agent door (the skill_* MCP tools) ──────────────────────────────────
// Writes are fenced to the AGENT TIER: a sandbox write must never change what
// other agents load, so workspace/org rows — member-visible, human-managed —
// answer FORBIDDEN with a dashboard pointer, and a name that exists nowhere
// visible answers NOT_FOUND. Reads see all three tiers (the same set the
// composer materializes, minus the shadow-merge — the agent needs to know
// what exists and which rows are its own).

/** Every tier that reaches this agent, flat, scope marked — enabled and
 * disabled alike (an agent must see its own paused rows to re-enable them). */
export const listSkillsReachingAgent = async (
  agentId: string,
  workspaceId: string,
  organizationId: string,
): Promise<SkillListItem[]> => {
  const rows = await db.skill.findMany({
    where: { OR: [{ agentId }, { workspaceId }, { organizationId }] },
    orderBy: [{ scope: "asc" }, { name: "asc" }],
    select: skillListSelect,
  });
  return rows.map(toListItem);
};

/** The write fence for the agent door: the agent's OWN row by name, or the
 * honest refusal. A broader-tier row with that name is FORBIDDEN with a
 * pointer (the requireWorkspaceWritableSkill posture); an unknown name is
 * NOT_FOUND. */
const requireAgentOwnSkill = async (
  agentId: string,
  workspaceId: string,
  organizationId: string,
  name: string,
) => {
  const own = await db.skill.findFirst({
    where: { agentId, name },
    select: {
      id: true,
      agentId: true,
      workspaceId: true,
      organizationId: true,
      description: true,
      content: true,
      enabled: true,
      files: { select: { path: true, content: true } },
    },
  });
  if (own) return own;
  const broader = await db.skill.findFirst({
    where: { name, OR: [{ workspaceId }, { organizationId }] },
    select: { scope: true },
  });
  if (broader) {
    throw new ServiceError(
      "FORBIDDEN",
      `"${name}" is a ${broader.scope}-level skill, managed by the people you work with in the dashboard. You can only change your own agent skills — or create an agent skill with this name, which takes precedence for you.`,
    );
  }
  throw new ServiceError(
    "NOT_FOUND",
    `You hold no agent skill named "${name}". skill_list shows what exists`,
  );
};

export const updateAgentSkillByName = async (
  agentId: string,
  workspaceId: string,
  organizationId: string,
  name: string,
  patch: SkillPatch,
): Promise<{ skill: SkillView; noop: boolean }> => {
  const existing = await requireAgentOwnSkill(
    agentId,
    workspaceId,
    organizationId,
    name,
  );
  const updated = await applyPatch(existing.id, existing, patch);
  if (!updated) return { skill: await getSkillById(existing.id), noop: true };
  await bumpHomeForAgent(agentId);
  return { skill: updated, noop: false };
};

export const deleteAgentSkillByName = async (
  agentId: string,
  workspaceId: string,
  organizationId: string,
  name: string,
): Promise<{ id: string }> => {
  const existing = await requireAgentOwnSkill(
    agentId,
    workspaceId,
    organizationId,
    name,
  );
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
      agentId: true,
      workspaceId: true,
      organizationId: true,
      description: true,
      content: true,
      enabled: true,
      files: { select: { path: true, content: true } },
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
  return skill;
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
