import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";
import {
  MAX_IMPORTED_SKILL_FILES,
  skillUpdateArgsSchema,
  updateSkillSchema,
} from "../validations/skills";
import type { ImportedSkill } from "./skill-import";

/**
 * Skills on REAL PostgreSQL (step 9). What only pg can prove: the
 * one-owner and scope-coherence CHECKs (two tiers: agent / organization —
 * the retired workspace scope is refused), the per-tier uniques under NULLS
 * DISTINCT, the fences with planted foreign-tenant negatives, the per-tier
 * caps that never cross-consume, the FORBIDDEN-vs-404 split on the
 * workspace door, and the deletion paths (agent cascade; the hand-written
 * org cascade whose Restrict FK fails loudly when forgotten).
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
  // Pinned per-suite: each file starts from the lane's edition (the hermetic
  // setup resets env per file), and CI's cloud lane carries
  // NEXT_PUBLIC_EDITION=cloud.
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
        { organizationId: { startsWith: P } },
        { agent: { identifier: { startsWith: P } } },
      ],
    },
  });
  await db.sandbox.deleteMany({
    where: { agent: { identifier: { startsWith: P } } },
  });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: { startsWith: P } } });
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
    const agent = await seedAgent("constraints");
    await expect(
      db.skill.create({
        data: {
          scope: "agent",
          agentId: agent,
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
          organizationId: ORG,
          name: "wrong-scope",
          description: "d",
          content: "c",
        },
      }),
    ).rejects.toThrow(/skills_scope_coherent/);
  });

  it("the retired workspace scope is refused at the database", async () => {
    await expect(
      db.skill.create({
        data: {
          scope: "workspace",
          organizationId: ORG,
          name: "retired-scope",
          description: "d",
          content: "c",
        },
      }),
    ).rejects.toThrow(/skills_scope_coherent/);
    // The deprecated workspace_id column (kept until the contract
    // migration) can never be set — the old door's exact shape is refused.
    await expect(
      db.skill.create({
        data: {
          scope: "workspace",
          workspaceId: WORKSPACE,
          name: "old-door",
          description: "d",
          content: "c",
        },
      }),
    ).rejects.toThrow(/skills_one_owner|skills_scope_coherent/);
    const agent = await seedAgent("ws-pinned");
    await expect(
      db.skill.create({
        data: {
          scope: "agent",
          agentId: agent,
          workspaceId: WORKSPACE,
          name: "sneaky",
          description: "d",
          content: "c",
        },
      }),
    ).rejects.toThrow(/skills_one_owner/);
  });

  it("per-tier name uniqueness; the SAME name across tiers coexists (the shadowing precondition)", async () => {
    const agent = await seedAgent("unique");
    await skillService.createSkill(
      WORKSPACE,
      { ...input("deploy"), agentId: agent },
      CREATOR,
    );
    await expect(
      skillService.createSkill(
        WORKSPACE,
        { ...input("deploy"), agentId: agent },
        CREATOR,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // Same name, org tier — legal, the composer shadows.
    await skillService.createOrgSkill(ORG, input("deploy"), CREATOR);
  });

  it("skill files are unique per path and die with their skill", async () => {
    const agent = await seedAgent("files");
    const skill = await skillService.createSkill(
      WORKSPACE,
      {
        ...input("with-files"),
        agentId: agent,
        files: [{ path: "ref.md", content: "r" }],
      },
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
  it("foreign agents' and foreign org rows are invisible, hint-free", async () => {
    const foreignAgent = await seedAgent("foreign-owner", FOREIGN_WORKSPACE);
    const foreignAgentRow = await skillService.createSkill(
      FOREIGN_WORKSPACE,
      { ...input("foreign-agent-skill"), agentId: foreignAgent },
      CREATOR,
    );
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
    await expect(
      skillService.getSkill(WORKSPACE, ORG, foreignAgentRow.id),
    ).rejects.toThrow("Skill not found");
    await expect(
      skillService.deleteSkill(WORKSPACE, ORG, foreignAgentRow.id),
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
    const agent = await seedAgent("capped");
    for (let i = 0; i < 10; i += 1) {
      await skillService.createSkill(
        WORKSPACE,
        { ...input(`filler-${i}`), agentId: agent },
        CREATOR,
      );
    }
    await expect(
      skillService.createSkill(
        WORKSPACE,
        { ...input("one-more"), agentId: agent },
        CREATOR,
      ),
    ).rejects.toThrow("already holds 10 skills");
    // A full agent tier leaves another agent and the org tier untouched.
    const other = await seedAgent("capfree");
    const created = await skillService.createSkill(
      WORKSPACE,
      { ...input("agent-skill"), agentId: other },
      CREATOR,
    );
    expect(created.scope).toBe("agent");
    const orgRow = await skillService.createOrgSkill(
      ORG,
      input("org-skill"),
      CREATOR,
    );
    expect(orgRow.scope).toBe("organization");
  });

  it("a hand-written skill's body and files no longer share one cap", async () => {
    // The old 32,000 sum is gone: the body has its own limit and each file
    // its own; the tier byte budget bounds the whole.
    const agent = await seedAgent("near-cap");
    const skill = await skillService.createSkill(
      WORKSPACE,
      {
        ...input("near-cap"),
        agentId: agent,
        content: "x".repeat(20_000),
        files: [{ path: "a.md", content: "y".repeat(10_000) }],
      },
      CREATOR,
    );
    await skillService.updateSkill(WORKSPACE, ORG, skill.id, {
      content: "x".repeat(40_000),
    });
    expect(
      (await db.skill.findUniqueOrThrow({ where: { id: skill.id } })).content
        .length,
    ).toBe(40_000);
  });

  it("the tier byte budget holds at every door that grows a skill", async () => {
    // Before, only a zip import checked it: hand-written skills grew a tier
    // past it, and the sync then left whole skills out to fit.
    const agent = await seedAgent("tier-budget");
    const held = await skillService.createSkill(
      WORKSPACE,
      { ...input("held"), agentId: agent },
      CREATOR,
    );
    // Fill the tier to 40,000 bytes under its 10 MB, straight in the
    // database (the way a zip import's binary files sit).
    await db.skillFile.create({
      data: {
        skillId: held.id,
        path: "data.bin",
        content: "",
        data: new Uint8Array(10 * 1024 * 1024 - 40_000),
      },
    });
    const refused = {
      code: "UNPROCESSABLE",
      message: expect.stringContaining("MB together"),
    };
    // Create, the dashboard's save, and the agent's skill_update: each is
    // held to the budget with what the tier already holds.
    await expect(
      skillService.createSkill(
        WORKSPACE,
        { ...input("new"), content: "x".repeat(50_000), agentId: agent },
        CREATOR,
      ),
    ).rejects.toMatchObject(refused);
    const small = await skillService.createSkill(
      WORKSPACE,
      { ...input("small"), agentId: agent },
      CREATOR,
    );
    await expect(
      skillService.updateSkill(WORKSPACE, ORG, small.id, {
        content: "x".repeat(50_000),
      }),
    ).rejects.toMatchObject(refused);
    // One append fits the room left; the next one would pass the budget.
    await expect(
      skillService.updateAgentSkillByName(agent, ORG, "small", {
        append: "x".repeat(24_000),
      }),
    ).resolves.toMatchObject({ noop: false });
    await expect(
      skillService.updateAgentSkillByName(agent, ORG, "small", {
        append: "x".repeat(24_000),
      }),
    ).rejects.toMatchObject(refused);
  });

  it("a write that does not grow an over-budget tier still saves", async () => {
    // A tier filled past its budget before every door checked can always be
    // paused, described, and trimmed.
    const agent = await seedAgent("over-budget");
    const skill = await skillService.createSkill(
      WORKSPACE,
      { ...input("over"), content: "x".repeat(50_000), agentId: agent },
      CREATOR,
    );
    await db.skillFile.create({
      data: {
        skillId: skill.id,
        path: "data.bin",
        content: "",
        data: new Uint8Array(11 * 1024 * 1024),
      },
    });
    await skillService.updateSkill(WORKSPACE, ORG, skill.id, {
      description: "still editable",
      enabled: false,
    });
    await skillService.updateSkill(WORKSPACE, ORG, skill.id, {
      content: "x".repeat(10_000),
    });
    const row = await db.skill.findUniqueOrThrow({ where: { id: skill.id } });
    expect(row).toMatchObject({
      description: "still editable",
      enabled: false,
    });
    expect(row.content.length).toBe(10_000);
  });
});

describe.skipIf(!PROOF_URL)("deletion paths", () => {
  it("agent delete cascades its own skills only", async () => {
    const agent = await seedAgent("cascade");
    const sibling = await seedAgent("sibling");
    await skillService.createSkill(
      WORKSPACE,
      { ...input("agent-owned"), agentId: agent },
      CREATOR,
    );
    await skillService.createSkill(
      WORKSPACE,
      { ...input("sibling-owned"), agentId: sibling },
      CREATOR,
    );
    await db.agent.delete({ where: { id: agent } });
    const names = (await db.skill.findMany({ select: { name: true } })).map(
      (s) => s.name,
    );
    expect(names).not.toContain("agent-owned");
    expect(names).toContain("sibling-owned");
  });

  it("deleteWorkspaceContent removes its agents' skills; org rows survive", async () => {
    const agent = await seedAgent("proj-del", WORKSPACE_B);
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

describe.skipIf(!PROOF_URL)("the agent door (the skill_* tools)", () => {
  it("lists both tiers that reach the agent, disabled rows included, foreign rows never", async () => {
    const agent = await seedAgent("lister");
    const sibling = await seedAgent("lister-sibling");
    const foreignAgent = await seedAgent("lister-foreign", FOREIGN_WORKSPACE);
    await skillService.createSkill(
      WORKSPACE,
      { ...input("mine"), agentId: agent, enabled: false },
      CREATOR,
    );
    await skillService.createOrgSkill(ORG, input("org-wide"), CREATOR);
    // Negatives: a sibling's row and foreign-tenant rows must not bleed in.
    await skillService.createSkill(
      WORKSPACE,
      { ...input("sibling-skill"), agentId: sibling },
      CREATOR,
    );
    await skillService.createSkill(
      FOREIGN_WORKSPACE,
      { ...input("mine"), agentId: foreignAgent },
      CREATOR,
    );
    await skillService.createOrgSkill(FOREIGN_ORG, input("org-wide"), CREATOR);

    const rows = await skillService.listSkillsReachingAgent(agent, ORG);
    expect(rows.map((row) => `${row.scope}:${row.name}`).sort()).toEqual([
      "agent:mine",
      "organization:org-wide",
    ]);
    // The disabled own row is visible — that is how it gets re-enabled.
    expect(rows.find((row) => row.name === "mine")?.enabled).toBe(false);
  });

  it("updates its own row by name and bumps only after a real change", async () => {
    const agent = await seedAgent("updater");
    await skillService.createSkill(
      WORKSPACE,
      { ...input("mine"), agentId: agent },
      CREATOR,
    );
    const runner = await db.runner.create({
      data: { id: `${P}runner`, name: "proof", token: `rnr_${P}tok` },
      select: { id: true },
    });
    const sandbox = await db.sandbox.create({
      data: {
        agentId: agent,
        runnerId: runner.id,
        status: "running",
        homeDesiredGeneration: 1,
      },
      select: { id: true },
    });

    const changed = await skillService.updateAgentSkillByName(
      agent,
      ORG,
      "mine",
      { enabled: false },
    );
    expect(changed.noop).toBe(false);
    expect(changed.skill.enabled).toBe(false);
    const afterChange = await db.sandbox.findUniqueOrThrow({
      where: { id: sandbox.id },
      select: { homeDesiredGeneration: true },
    });
    expect(afterChange.homeDesiredGeneration).toBe(2);

    const noop = await skillService.updateAgentSkillByName(agent, ORG, "mine", {
      enabled: false,
    });
    expect(noop.noop).toBe(true);
    const afterNoop = await db.sandbox.findUniqueOrThrow({
      where: { id: sandbox.id },
      select: { homeDesiredGeneration: true },
    });
    expect(afterNoop.homeDesiredGeneration).toBe(2);
  });

  it("an org-tier name answers FORBIDDEN with the dashboard pointer, not a write", async () => {
    const agent = await seedAgent("fenced");
    await skillService.createOrgSkill(ORG, input("shared"), CREATOR);
    await expect(
      skillService.updateAgentSkillByName(agent, ORG, "shared", {
        enabled: false,
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("dashboard"),
    });
    await expect(
      skillService.deleteAgentSkillByName(agent, ORG, "shared"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The row survived both refusals.
    expect(await db.skill.count({ where: { name: "shared" } })).toBe(1);
  });

  it("an unknown name — and ANOTHER AGENT'S name — answer hint-free NOT_FOUND", async () => {
    const agent = await seedAgent("owner");
    const otherAgent = await seedAgent("other");
    await skillService.createSkill(
      WORKSPACE,
      { ...input("theirs"), agentId: otherAgent },
      CREATOR,
    );
    // A sibling agent's row is invisible to this agent's door: same words as
    // a name that exists nowhere.
    for (const name of ["theirs", "never-existed"]) {
      await expect(
        skillService.updateAgentSkillByName(agent, ORG, name, {
          enabled: false,
        }),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: expect.stringContaining(`no agent skill named "${name}"`),
      });
    }
  });

  it("deletes its own row by name and bumps", async () => {
    const agent = await seedAgent("deleter");
    await skillService.createSkill(
      WORKSPACE,
      { ...input("mine"), agentId: agent },
      CREATOR,
    );
    await skillService.deleteAgentSkillByName(agent, ORG, "mine");
    expect(await db.skill.count({ where: { agentId: agent } })).toBe(0);
  });

  it("the update path keeps the files and holds an in-place edit to the one body limit", async () => {
    const agent = await seedAgent("budget");
    await skillService.createSkill(
      WORKSPACE,
      {
        ...input("fat"),
        agentId: agent,
        files: [{ path: "ref.md", content: "x".repeat(20_000) }],
      },
      CREATOR,
    );
    // Body and files no longer share a 32k sum: this used to be refused.
    const grown = await skillService.updateAgentSkillByName(agent, ORG, "fat", {
      content: "y".repeat(13_000),
    });
    expect(grown.skill.files.map((f) => f.path)).toEqual(["ref.md"]);
    // An edit that would pass 120,000 is refused, and nothing is saved.
    await expect(
      skillService.updateAgentSkillByName(agent, ORG, "fat", {
        append: "z".repeat(107_001),
      }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    expect(
      (await db.skill.findFirstOrThrow({ where: { agentId: agent } })).content
        .length,
    ).toBe(13_000);
  });

  it("parallel in-place edits never lose one that reported success", async () => {
    // An in-place edit is computed from the body as read. Two in flight read
    // the same body; a blind write would keep only the last one while both
    // answered "Updated". The write is conditional on the body it read, so
    // the loser saves nothing and says so.
    const agent = await seedAgent("race");
    await skillService.createSkill(
      WORKSPACE,
      { ...input("race"), content: "one\ntwo", agentId: agent },
      CREATOR,
    );
    for (let round = 0; round < 10; round += 1) {
      await db.skill.updateMany({
        where: { agentId: agent },
        data: { content: "one\ntwo" },
      });
      const results = await Promise.allSettled(
        (["one", "two"] as const).map((find) =>
          skillService.updateAgentSkillByName(agent, ORG, "race", {
            edits: [{ find, replace: find.toUpperCase() }],
          }),
        ),
      );
      const { content } = await db.skill.findFirstOrThrow({
        where: { agentId: agent },
      });
      const landed = (find: string) => content.includes(find.toUpperCase());
      results.forEach((result, index) => {
        const find = index === 0 ? "one" : "two";
        if (result.status === "fulfilled") expect(landed(find)).toBe(true);
        else {
          expect(result.reason).toMatchObject({ code: "CONFLICT" });
          expect(landed(find)).toBe(false);
        }
      });
    }
  });

  it("an in-place edit racing a delete answers NOT_FOUND, never a retry", async () => {
    const agent = await seedAgent("race-delete");
    await skillService.createSkill(
      WORKSPACE,
      { ...input("doomed"), content: "one", agentId: agent },
      CREATOR,
    );
    const results = await Promise.allSettled([
      skillService.updateAgentSkillByName(agent, ORG, "doomed", {
        append: "two",
      }),
      skillService.deleteAgentSkillByName(agent, ORG, "doomed"),
    ]);
    expect(await db.skill.count({ where: { agentId: agent } })).toBe(0);
    // Either the edit landed before the delete, or it found nothing to edit:
    // a deleted skill is never answered with "send the edit again".
    const [edit] = results;
    if (edit?.status === "rejected") {
      expect(edit.reason).toMatchObject({ code: "NOT_FOUND" });
    }
  });
});

describe.skipIf(!PROOF_URL)("folder skills from a zip (pg)", () => {
  const imported = (name: string): ImportedSkill => ({
    folder: name,
    name,
    description: "Use it for incidents.",
    content: "# Tools\n\nRun ./run.",
    bytes: 0,
    skipped: [],
    fingerprint: "f".repeat(64),
    files: [
      {
        path: "run",
        content: "#!/bin/sh\n",
        data: null,
        executable: true,
      },
      {
        path: "fixtures/incidents/a.json",
        content: "{}",
        data: null,
        executable: false,
      },
      {
        path: "assets/logo.png",
        content: "",
        data: Buffer.from([0, 1, 255]),
        executable: false,
      },
    ],
  });

  it("saves every file, keeps binary bytes and the runnable flag", async () => {
    const agentId = await seedAgent("zip");
    const [outcome] = await skillService.importAgentSkills(
      WORKSPACE,
      agentId,
      [imported(`${P}tools`)],
      CREATOR,
    );
    expect(outcome).toMatchObject({ files: 4, replaced: false });
    const files = await db.skillFile.findMany({
      where: { skill: { agentId } },
      orderBy: { path: "asc" },
      select: { path: true, data: true, executable: true },
    });
    expect(files.map((f) => [f.path, f.executable])).toEqual([
      ["assets/logo.png", false],
      ["fixtures/incidents/a.json", false],
      ["run", true],
    ]);
    expect(Buffer.from(files[0]!.data!)).toEqual(Buffer.from([0, 1, 255]));
  });

  it("re-importing the same name replaces it instead of failing", async () => {
    const agentId = await seedAgent("zip2");
    await skillService.importAgentSkills(
      WORKSPACE,
      agentId,
      [imported(`${P}tools`)],
      CREATOR,
    );
    const again = {
      ...imported(`${P}tools`),
      files: [imported(`${P}tools`).files[0]!],
    };
    const [outcome] = await skillService.importAgentSkills(
      WORKSPACE,
      agentId,
      [again],
      CREATOR,
    );
    expect(outcome?.replaced).toBe(true);
    expect(await db.skillFile.count({ where: { skill: { agentId } } })).toBe(1);
  });

  it("a description stored before the doors cleaned it reads clean, and a save rewrites it", async () => {
    const agentId = await seedAgent("legacy-desc");
    const dirty = `Old${String.fromCharCode(0x07)} row${String.fromCharCode(0x202e)} here`;
    const row = await db.skill.create({
      data: {
        scope: "agent",
        agentId,
        name: `${P}legacy`,
        description: dirty,
        content: "# body",
      },
    });
    const view = await skillService.getSkill(WORKSPACE, ORG, row.id);
    expect(view.description).toBe("Old row here");
    const listed = await skillService.listSkillsForWorkspace(WORKSPACE, ORG);
    expect(listed.find((s) => s.id === row.id)?.description).toBe(
      "Old row here",
    );
    // The editor sends back what it showed; that rewrites the row clean.
    await skillService.updateSkill(WORKSPACE, ORG, row.id, {
      description: view.description,
    });
    const stored = await db.skill.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.description).toBe("Old row here");
  });

  it("names each saved row by id, the same row when a name is replaced", async () => {
    const agentId = await seedAgent("zip-ids");
    const [first, second] = await skillService.importAgentSkills(
      WORKSPACE,
      agentId,
      [imported(`${P}tools`), imported(`${P}notes`)],
      CREATOR,
    );
    const rows = await db.skill.findMany({
      where: { agentId },
      select: { id: true, name: true },
    });
    const idOf = new Map(rows.map((r) => [r.name, r.id]));
    expect(first?.id).toBe(idOf.get(`${P}tools`));
    expect(second?.id).toBe(idOf.get(`${P}notes`));
    expect(first?.id).not.toBe(second?.id);

    const [again] = await skillService.importAgentSkills(
      WORKSPACE,
      agentId,
      [imported(`${P}tools`)],
      CREATOR,
    );
    expect(again).toMatchObject({ id: first?.id, replaced: true });
  });

  it("editing the description in the dashboard keeps imported files", async () => {
    const agentId = await seedAgent("zip3");
    await skillService.importAgentSkills(
      WORKSPACE,
      agentId,
      [imported(`${P}tools`)],
      CREATOR,
    );
    const skill = await db.skill.findFirstOrThrow({ where: { agentId } });
    const view = await skillService.getSkill(WORKSPACE, ORG, skill.id);
    // The dashboard sends back only the files it can edit (text ones).
    const editable = view.files
      .filter((f) => f.editable)
      .map((f) => ({ path: f.path, content: f.content }));
    await skillService.updateSkill(WORKSPACE, ORG, skill.id, {
      description: "New words.",
      files: editable,
    });
    expect(await db.skillFile.count({ where: { skillId: skill.id } })).toBe(3);
    const binary = view.files.find((f) => f.path === "assets/logo.png");
    expect(binary).toMatchObject({
      binary: true,
      editable: false,
      content: "",
    });
  });

  it("refuses an import that would pass the agent's skill count", async () => {
    const agentId = await seedAgent("zip4");
    const many = Array.from({ length: 11 }, (_, i) => imported(`${P}s${i}`));
    await expect(
      skillService.importAgentSkills(WORKSPACE, agentId, many, CREATOR),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    // All or nothing: not one of them was saved.
    expect(await db.skill.count({ where: { agentId } })).toBe(0);
  });

  it("refuses an import past the tier's byte budget, counting what is held", async () => {
    const agentId = await seedAgent("zip-bytes");
    const heavy = (name: string) => ({
      ...imported(name),
      bytes: 6 * 1024 * 1024,
    });
    await skillService.importAgentSkills(
      WORKSPACE,
      agentId,
      [heavy(`${P}h1`)],
      CREATOR,
    );
    // Held bytes are measured in the database, not taken from the caller.
    await db.skillFile.create({
      data: {
        skill: { connect: { agentId_name: { agentId, name: `${P}h1` } } },
        path: "big.bin",
        content: "",
        data: new Uint8Array(6 * 1024 * 1024),
      },
    });
    await expect(
      skillService.importAgentSkills(
        WORKSPACE,
        agentId,
        [heavy(`${P}h2`)],
        CREATOR,
      ),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    // Replacing the held skill frees its bytes.
    await expect(
      skillService.importAgentSkills(
        WORKSPACE,
        agentId,
        [heavy(`${P}h1`)],
        CREATOR,
      ),
    ).resolves.toHaveLength(1);
  });

  it("concurrent imports can't both pass the count cap", async () => {
    const agentId = await seedAgent("zip-race");
    const batch = (from: number) =>
      Array.from({ length: 6 }, (_, i) => imported(`${P}r${from + i}`));
    const results = await Promise.allSettled([
      skillService.importAgentSkills(WORKSPACE, agentId, batch(0), CREATOR),
      skillService.importAgentSkills(WORKSPACE, agentId, batch(10), CREATOR),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(await db.skill.count({ where: { agentId } })).toBe(6);
  });

  it("imports nothing and bumps nothing for an empty list", async () => {
    const agentId = await seedAgent("zip-empty");
    await expect(
      skillService.importAgentSkills(WORKSPACE, agentId, [], CREATOR),
    ).resolves.toEqual([]);
  });

  it("a runnable text file is listed, not edited, and a save keeps its flag", async () => {
    const agentId = await seedAgent("zip-exec");
    await skillService.importAgentSkills(
      WORKSPACE,
      agentId,
      [{ ...imported(`${P}x`), files: [imported(`${P}x`).files[0]!] }],
      CREATOR,
    );
    const skill = await db.skill.findFirstOrThrow({ where: { agentId } });
    const view = await skillService.getSkill(WORKSPACE, ORG, skill.id);
    expect(view.files).toEqual([
      expect.objectContaining({ path: "run", editable: false, content: "" }),
    ]);
    await skillService.updateSkill(WORKSPACE, ORG, skill.id, {
      files: [{ path: "notes.md", content: "added" }],
    });
    const run = await db.skillFile.findFirstOrThrow({
      where: { skillId: skill.id, path: "run" },
    });
    expect(run.executable).toBe(true);
  });

  it("a long imported skill with a file edits and grows from both doors", async () => {
    // A 46,000-char body plus an 8,000-char file. Before the one limit, the
    // dashboard held such a body to its imported length (counting the file
    // too, so it could not grow at all) and skill_update capped it at 24,000.
    const agentId = await seedAgent("zip-long");
    const name = `${P}long`;
    const long = "# Long\n\n" + "x".repeat(45_992);
    expect(long.length).toBe(46_000);
    await skillService.importAgentSkills(
      WORKSPACE,
      agentId,
      [
        {
          ...imported(name),
          content: long,
          files: [
            {
              path: "references/gotchas.md",
              content: "g".repeat(8_000),
              data: null,
              executable: false,
            },
          ],
        },
      ],
      CREATOR,
    );
    const skill = await db.skill.findFirstOrThrow({ where: { agentId } });
    const twoLines = "\n- one more rule\n- and another";

    // The dashboard door: PATCH through the schema, as the route does.
    const dashboard = updateSkillSchema.parse({
      content: `${long}${twoLines}`,
    });
    await skillService.updateSkill(WORKSPACE, ORG, skill.id, dashboard);
    expect(
      (await db.skill.findUniqueOrThrow({ where: { id: skill.id } })).content,
    ).toBe(`${long}${twoLines}`.trim());

    // The agent door: skill_update's own args schema, then the service. The
    // whole body can't ride the 32k tool pipe, so the agent edits in place.
    const { edits, append } = skillUpdateArgsSchema.parse({
      name,
      edits: [{ find: "# Long", replace: "# Long checklist" }],
      append: "- Tag the release after the smoke tests pass.",
    });
    await skillService.updateAgentSkillByName(agentId, ORG, name, {
      edits,
      append,
    });
    const saved = await db.skill.findUniqueOrThrow({
      where: { id: skill.id },
      include: { files: true },
    });
    expect(saved.content.startsWith("# Long checklist\n\n")).toBe(true);
    expect(saved.content).toContain(twoLines.trim());
    expect(
      saved.content.endsWith(
        "\n\n- Tag the release after the smoke tests pass.",
      ),
    ).toBe(true);
    // Saving the body never touched the imported file.
    expect(saved.files.map((f) => f.path)).toEqual(["references/gotchas.md"]);

    // A find that matches more than once (or not at all) saves nothing.
    await expect(
      skillService.updateAgentSkillByName(agentId, ORG, name, {
        edits: [{ find: "x", replace: "y" }],
      }),
    ).rejects.toThrow("occurs more than once");
    expect(
      (await db.skill.findUniqueOrThrow({ where: { id: skill.id } })).content,
    ).toBe(saved.content);
  });

  it("refuses a dashboard file that clashes with a kept imported file", async () => {
    const agentId = await seedAgent("zip-clash");
    await skillService.importAgentSkills(
      WORKSPACE,
      agentId,
      [imported(`${P}c`)],
      CREATOR,
    );
    const skill = await db.skill.findFirstOrThrow({ where: { agentId } });
    await expect(
      skillService.updateSkill(WORKSPACE, ORG, skill.id, {
        files: [{ path: "assets", content: "a file where a folder is" }],
      }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("a patch never grows an imported skill past its file limit", async () => {
    const agentId = await seedAgent("zip-count");
    const full = Array.from(
      { length: MAX_IMPORTED_SKILL_FILES - 1 },
      (_, i) => ({
        path: `f/${i}.txt`,
        content: "x",
        data: null,
        executable: false,
      }),
    );
    await skillService.importAgentSkills(
      WORKSPACE,
      agentId,
      [{ ...imported(`${P}full`), files: full }],
      CREATOR,
    );
    const skill = await db.skill.findFirstOrThrow({ where: { agentId } });
    await expect(
      skillService.updateSkill(WORKSPACE, ORG, skill.id, {
        files: [{ path: "one-more.md", content: "y" }],
      }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    // Rewriting a file it already holds stays inside the limit.
    await skillService.updateSkill(WORKSPACE, ORG, skill.id, {
      files: [{ path: "f/0.txt", content: "rewritten" }],
    });
    expect(await db.skillFile.count({ where: { skillId: skill.id } })).toBe(
      MAX_IMPORTED_SKILL_FILES - 1,
    );
  });

  it("never imports into another workspace's agent", async () => {
    const foreign = await seedAgent("zipf", FOREIGN_WORKSPACE);
    await expect(
      skillService.importAgentSkills(
        WORKSPACE,
        foreign,
        [imported(`${P}x`)],
        CREATOR,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
