import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * Skills on REAL PostgreSQL (step 9). What only pg can prove: the
 * one-owner and scope-coherence CHECKs, the three per-tier uniques under
 * NULLS DISTINCT, the fences with planted foreign-tenant negatives, the
 * per-tier caps that never cross-consume, the FORBIDDEN-vs-404 split on the
 * workspace door, and the deletion paths (agent cascade; the hand-written
 * workspace/org cascades whose Restrict FKs fail loudly when forgotten).
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type SkillService = typeof import("./skill-service");
type WorkspaceService = typeof import("../ee/services/workspace-service");
type OrganizationService = typeof import("../ee/services/organization-service");

let db: Db;
let skillService: SkillService;
let workspaceService: WorkspaceService;
let organizationService: OrganizationService;

const P = "skl-";
const ORG = `${P}org`;
const WORKSPACE = `${P}proj`;
const WORKSPACE_B = `${P}proj-b`;
const FOREIGN_ORG = `${P}forg`;
const FOREIGN_WORKSPACE = `${P}fproj`;
const USER = `${P}user`;

const CREATOR = { userId: USER, email: `${P}user@example.com` };

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  // Pinned per-suite: process.env leaks across worker files, and CI's ambient
  // NEXT_PUBLIC_EDITION is cloud.
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";

  ({ db } = await import("@onecli/db"));
  skillService = await import("./skill-service");
  workspaceService = await import("../ee/services/workspace-service");
  organizationService = await import("../ee/services/organization-service");

  await resetAll();
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await resetAll();
});

const resetAll = async () => {
  await db.skill.deleteMany({
    where: {
      OR: [
        { name: { startsWith: P } },
        { workspaceId: { startsWith: P } },
        { organizationId: { startsWith: P } },
        { agent: { identifier: { startsWith: P } } },
      ],
    },
  });
  await db.sandbox.deleteMany({
    where: { agent: { identifier: { startsWith: P } } },
  });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.auditLog.deleteMany({ where: { userId: USER } });
  await db.user.deleteMany({ where: { id: USER } });
  await db.apiKey.deleteMany({ where: { workspaceId: { startsWith: P } } });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organizationMember.deleteMany({
    where: { organizationId: { startsWith: P } },
  });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

beforeEach(async () => {
  if (!PROOF_URL) return;
  await resetAll();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "Skills Workspace", organizationId: ORG },
  });
  await db.workspace.create({
    data: { id: WORKSPACE_B, name: "Second Workspace", organizationId: ORG },
  });
  await db.organization.create({
    data: { id: FOREIGN_ORG, name: FOREIGN_ORG, slug: FOREIGN_ORG },
  });
  await db.workspace.create({
    data: {
      id: FOREIGN_WORKSPACE,
      name: "Foreign Workspace",
      organizationId: FOREIGN_ORG,
    },
  });
  await db.user.create({
    data: {
      id: USER,
      email: `${P}user@example.com`,
      externalAuthId: `${P}auth`,
    },
  });
});

const seedAgent = async (
  suffix: string,
  workspaceId = WORKSPACE,
  kind = "hosted",
) => {
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `agent ${suffix}`,
      identifier: `${P}${suffix}`,
      accessToken: `aoc_${P}${suffix}`,
      kind,
      ...(kind === "hosted" && { harness: "fake" }),
    },
    select: { id: true },
  });
  return agent.id;
};

const input = (name: string) => ({
  name,
  description: "what it does",
  content: "# body",
});

describe.skipIf(!PROOF_URL)("the schema constraints", () => {
  it("exactly one owner column, and scope must name it", async () => {
    await expect(
      db.skill.create({
        data: {
          scope: "workspace",
          workspaceId: WORKSPACE,
          organizationId: ORG,
          name: "two-owners",
          description: "d",
          content: "c",
        },
      }),
    ).rejects.toThrow(/skills_one_owner/);
    await expect(
      db.skill.create({
        data: {
          scope: "agent",
          workspaceId: WORKSPACE,
          name: "wrong-scope",
          description: "d",
          content: "c",
        },
      }),
    ).rejects.toThrow(/skills_scope_coherent/);
  });

  it("per-tier name uniqueness; the SAME name across tiers coexists (the shadowing precondition)", async () => {
    await db.skill.create({
      data: {
        scope: "workspace",
        workspaceId: WORKSPACE,
        name: "deploy",
        description: "d",
        content: "c",
      },
    });
    await expect(
      db.skill.create({
        data: {
          scope: "workspace",
          workspaceId: WORKSPACE,
          name: "deploy",
          description: "d",
          content: "c",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    // Same name, org tier — legal, the composer shadows.
    await db.skill.create({
      data: {
        scope: "organization",
        organizationId: ORG,
        name: "deploy",
        description: "d",
        content: "c",
      },
    });
  });

  it("skill files are unique per path and die with their skill", async () => {
    const skill = await skillService.createSkill(
      WORKSPACE,
      { ...input("with-files"), files: [{ path: "ref.md", content: "r" }] },
      CREATOR,
    );
    await expect(
      db.skillFile.create({
        data: { skillId: skill.id, path: "ref.md", content: "dup" },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await skillService.deleteSkill(WORKSPACE, ORG, skill.id);
    expect(await db.skillFile.count({ where: { skillId: skill.id } })).toBe(0);
  });
});

describe.skipIf(!PROOF_URL)("the fences", () => {
  it("foreign workspace and foreign org rows are invisible, hint-free", async () => {
    await db.skill.create({
      data: {
        scope: "workspace",
        workspaceId: FOREIGN_WORKSPACE,
        name: "foreign-workspace-skill",
        description: "d",
        content: "c",
      },
    });
    const foreignOrgRow = await db.skill.create({
      data: {
        scope: "organization",
        organizationId: FOREIGN_ORG,
        name: "foreign-org-skill",
        description: "d",
        content: "c",
      },
    });

    const listed = await skillService.listSkillsForWorkspace(WORKSPACE, ORG);
    expect(listed.map((s) => s.name)).toEqual([]);

    await expect(
      skillService.getSkill(WORKSPACE, ORG, foreignOrgRow.id),
    ).rejects.toThrow("Skill not found");
    // A FOREIGN org's row through the workspace write door: hint-free 404,
    // never the FORBIDDEN pointer (that is for the CALLER'S org rows).
    await expect(
      skillService.updateSkill(WORKSPACE, ORG, foreignOrgRow.id, {
        content: "x",
      }),
    ).rejects.toThrow("Skill not found");
  });

  it("the caller's org rows read here but write FORBIDDEN with the pointer", async () => {
    const orgRow = await skillService.createOrgSkill(
      ORG,
      input("org-standards"),
      CREATOR,
    );
    const listed = await skillService.listSkillsForWorkspace(WORKSPACE, ORG);
    expect(listed.map((s) => s.name)).toContain("org-standards");
    await expect(
      skillService.updateSkill(WORKSPACE, ORG, orgRow.id, { content: "x" }),
    ).rejects.toThrow("managed in organization settings");
    await expect(
      skillService.deleteSkill(WORKSPACE, ORG, orgRow.id),
    ).rejects.toThrow("managed in organization settings");
  });

  it("agent tier: foreign agents 404, BYO agents refused", async () => {
    const foreignAgent = await seedAgent("foreign", FOREIGN_WORKSPACE);
    await expect(
      skillService.createSkill(
        WORKSPACE,
        { ...input("x"), agentId: foreignAgent },
        CREATOR,
      ),
    ).rejects.toThrow("Agent not found");

    const byo = await seedAgent("byo", WORKSPACE, "byo");
    await expect(
      skillService.createSkill(
        WORKSPACE,
        { ...input("y"), agentId: byo },
        CREATOR,
      ),
    ).rejects.toThrow("Only hosted agents can hold skills");
  });
});

describe.skipIf(!PROOF_URL)("caps and reserved names", () => {
  it("each tier caps independently — tiers never cross-consume", async () => {
    for (let i = 0; i < 20; i += 1) {
      await db.skill.create({
        data: {
          scope: "workspace",
          workspaceId: WORKSPACE,
          name: `filler-${i}`,
          description: "d",
          content: "c",
        },
      });
    }
    await expect(
      skillService.createSkill(WORKSPACE, input("one-more"), CREATOR),
    ).rejects.toThrow("already holds 20 skills");
    // A full workspace tier leaves the agent tier untouched.
    const agent = await seedAgent("capfree");
    const created = await skillService.createSkill(
      WORKSPACE,
      { ...input("agent-skill"), agentId: agent },
      CREATOR,
    );
    expect(created.scope).toBe("agent");
  });

  it("the merged-row budget re-check blocks a PATCH that smuggles the sum over", async () => {
    const skill = await skillService.createSkill(
      WORKSPACE,
      {
        ...input("near-cap"),
        content: "x".repeat(20_000),
        files: [{ path: "a.md", content: "y".repeat(10_000) }],
      },
      CREATOR,
    );
    await expect(
      skillService.updateSkill(WORKSPACE, ORG, skill.id, {
        content: "x".repeat(24_000),
      }),
    ).rejects.toThrow("limited to 32,000 characters");
  });
});

describe.skipIf(!PROOF_URL)("deletion paths", () => {
  it("agent delete cascades its agent-tier skills only", async () => {
    const agent = await seedAgent("cascade");
    await skillService.createSkill(
      WORKSPACE,
      { ...input("agent-owned"), agentId: agent },
      CREATOR,
    );
    await skillService.createSkill(
      WORKSPACE,
      input("workspace-owned"),
      CREATOR,
    );
    await db.agent.delete({ where: { id: agent } });
    const names = (await db.skill.findMany({ select: { name: true } })).map(
      (s) => s.name,
    );
    expect(names).not.toContain("agent-owned");
    expect(names).toContain("workspace-owned");
  });

  it("deleteWorkspaceContent removes workspace-tier rows; org rows survive (the Restrict proof)", async () => {
    const agent = await seedAgent("proj-del", WORKSPACE_B);
    await skillService.createSkill(
      WORKSPACE_B,
      input("workspace-owned"),
      CREATOR,
    );
    await skillService.createSkill(
      WORKSPACE_B,
      { ...input("agent-owned"), agentId: agent },
      CREATOR,
    );
    await skillService.createOrgSkill(ORG, input("org-survivor"), CREATOR);

    await db.$transaction(async (tx) => {
      await workspaceService.deleteWorkspaceContent(WORKSPACE_B, tx);
    });

    const names = (await db.skill.findMany({ select: { name: true } })).map(
      (s) => s.name,
    );
    expect(names).not.toContain("workspace-owned");
    expect(names).not.toContain("agent-owned");
    expect(names).toContain("org-survivor");
  });

  it("deleteOrganizationContent removes org-tier rows", async () => {
    // A scratch org with no workspaces — the precondition the real caller holds.
    const scratchOrg = `${P}scratch-org`;
    await db.organization.create({
      data: { id: scratchOrg, name: scratchOrg, slug: scratchOrg },
    });
    await skillService.createOrgSkill(scratchOrg, input("org-owned"), CREATOR);
    await db.$transaction(async (tx) => {
      await organizationService.deleteOrganizationContent(scratchOrg, tx);
    });
    expect(
      await db.skill.count({ where: { organizationId: scratchOrg } }),
    ).toBe(0);
    expect(await db.organization.count({ where: { id: scratchOrg } })).toBe(0);
  });
});
