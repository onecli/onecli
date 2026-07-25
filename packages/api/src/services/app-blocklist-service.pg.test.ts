import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The app blocklist on REAL PostgreSQL — the committed proof that a blocked host
 * actually reaches the set the gateway enforces.
 *
 * This is the regression that motivated the suite: the blocklist used to write
 * the old `policy_rules` table and rely on a background pass to copy the rows
 * into `policy_rules_v2`. When that pass was deleted, blocking a host became a
 * silent no-op — the panel said "Blocking npm Registry" and the host stayed
 * reachable. Mocks can't catch that class of bug, because the whole question is
 * WHICH ROWS LAND IN WHICH GENERATION, so this drives real writes and then reads
 * back with the gateway's own query shape (published ∧ max(generation) ∧ enabled).
 *
 * Env-gated: skipped unless POLICY_PROOF_DATABASE_URL points at a migrated
 * PostgreSQL, e.g.
 *
 *   docker run -d --name blocklist-proof-pg -e POSTGRES_PASSWORD=postgres \
 *     -e POSTGRES_DB=onecli -p 5440:5432 postgres:18-alpine
 *   DATABASE_URL="postgresql://postgres:postgres@localhost:5440/onecli" \
 *     pnpm --filter @onecli/db exec prisma migrate deploy
 *   POLICY_PROOF_DATABASE_URL="postgresql://postgres:postgres@localhost:5440/onecli" \
 *     pnpm --filter @onecli/api test -- --run src/services/app-blocklist-service.pg.test.ts
 */

const PROOF_URL = process.env.POLICY_PROOF_DATABASE_URL;

// Dynamic imports: @onecli/db builds its client from DATABASE_URL at import
// time, so the env must be staged first.
type Db = typeof import("@onecli/db").db;
type Service = typeof import("./app-blocklist-service");

let db: Db;
let svc: Service;

const P = "blproof-";
const ORG = `${P}org`;
const PROJECT = `${P}proj`;
const FENCE = `${P}fence`;

const NPM = {
  id: "npm",
  name: "npm Registry",
  hostPattern: "registry.npmjs.org",
};
const PYPI = { id: "pypi", name: "PyPI", hostPattern: "pypi.org" };
const HOSTS = [NPM, PYPI];

/** The gateway's own read: published, live generation, enabled only. */
const enforcedHosts = async (projectId: string): Promise<string[]> => {
  const live = await db.policyRuleV2.aggregate({
    where: { scope: "project", projectId, status: "published" },
    _max: { generation: true },
  });
  const rows = await db.policyRuleV2.findMany({
    where: {
      scope: "project",
      projectId,
      status: "published",
      enabled: true,
      generation: live._max.generation ?? -1,
    },
    select: { action: true, targets: { select: { hostPattern: true } } },
    orderBy: [{ priority: "asc" }, { id: "asc" }],
  });
  return rows
    .filter((r) => r.action === "block")
    .flatMap((r) => r.targets.map((t) => t.hostPattern ?? ""))
    .filter(Boolean);
};

const orderedRules = async (projectId: string, status: string) => {
  const where =
    status === "published"
      ? {
          scope: "project" as const,
          projectId,
          status,
          generation:
            (
              await db.policyRuleV2.aggregate({
                where: { scope: "project", projectId, status: "published" },
                _max: { generation: true },
              })
            )._max.generation ?? -1,
        }
      : { scope: "project" as const, projectId, status };
  return db.policyRuleV2.findMany({
    where: { ...where, isDefault: false },
    select: { name: true, action: true, source: true, priority: true },
    orderBy: [{ priority: "asc" }, { id: "asc" }],
  });
};

const reset = async () => {
  await db.policyRuleTarget.deleteMany({
    where: { rule: { organizationId: ORG } },
  });
  await db.policyRuleV2.deleteMany({ where: { organizationId: ORG } });
  await db.policyRuleV2.deleteMany({
    where: { projectId: { in: [PROJECT, FENCE] } },
  });
  await db.project.deleteMany({ where: { id: { in: [PROJECT, FENCE] } } });
  await db.organization.deleteMany({ where: { id: ORG } });
};

/** A project that has already published once — the normal state, since every new
 * scope is seeded with a published Default Rule. Carries one `allow` rule so the
 * block's placement (before anything looser) is observable. */
const seedPublishedProject = async (projectId: string) => {
  await db.project.create({
    data: { id: projectId, name: projectId, organizationId: ORG },
  });
  for (const [status, generation] of [
    ["draft", 0],
    ["published", 1],
  ] as const) {
    await db.policyRuleV2.create({
      data: {
        scope: "project",
        projectId,
        status,
        generation,
        priority: 0,
        isDefault: true,
        source: "default",
        name: "Default Rule",
        action: "allow",
        requireApproval: false,
      },
    });
    await db.policyRuleV2.create({
      data: {
        scope: "project",
        projectId,
        status,
        generation,
        priority: 1,
        isDefault: false,
        source: "custom",
        logicalId: `${projectId}-allow`,
        name: "Allow everything",
        action: "allow",
        requireApproval: false,
        targets: {
          create: [{ kind: "network", hostPattern: "*", pathPattern: "/*" }],
        },
      },
    });
  }
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  svc = await import("./app-blocklist-service");
  await reset();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.$disconnect();
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await db.policyRuleV2.deleteMany({
    where: { projectId: { in: [PROJECT, FENCE] } },
  });
  await db.project.deleteMany({ where: { id: { in: [PROJECT, FENCE] } } });
  await seedPublishedProject(PROJECT);
  await seedPublishedProject(FENCE);
});

describe.skipIf(!PROOF_URL)("app blocklist over real PostgreSQL", () => {
  it("a seeded block reaches the generation the gateway enforces", async () => {
    await svc.initBlocklistDefaults({ projectId: PROJECT }, "jfrog", HOSTS);

    // THE regression: the rule must be in the LIVE PUBLISHED set, not just the
    // draft — a draft-only write is exactly the silent no-op this replaced.
    await expect(enforcedHosts(PROJECT)).resolves.toEqual(
      expect.arrayContaining([NPM.hostPattern, PYPI.hostPattern]),
    );

    // ...and in the draft too, so the next publish carries it forward instead of
    // dropping it.
    const draft = await orderedRules(PROJECT, "draft");
    expect(draft.filter((r) => r.source === "blocklist")).toHaveLength(2);
  });

  it("places the block BEFORE looser rules in both sets", async () => {
    await svc.initBlocklistDefaults({ projectId: PROJECT }, "jfrog", [NPM]);
    for (const status of ["draft", "published"]) {
      const rules = await orderedRules(PROJECT, status);
      expect(rules.map((r) => r.action)).toEqual(["block", "allow"]);
      expect(rules[0]!.source).toBe("blocklist");
    }
  });

  it("toggling off stops enforcement in the live generation", async () => {
    await svc.initBlocklistDefaults({ projectId: PROJECT }, "jfrog", [NPM]);
    const [state] = await svc.getBlocklistState(
      { projectId: PROJECT },
      "jfrog",
      [NPM],
    );
    expect(state!.enabled).toBe(true);

    await svc.toggleBlocklistRule(
      { projectId: PROJECT },
      state!.ruleId!,
      false,
    );
    await expect(enforcedHosts(PROJECT)).resolves.not.toContain(
      NPM.hostPattern,
    );

    await svc.toggleBlocklistRule({ projectId: PROJECT }, state!.ruleId!, true);
    await expect(enforcedHosts(PROJECT)).resolves.toContain(NPM.hostPattern);
  });

  it("removing the app's blocks clears both sets", async () => {
    await svc.initBlocklistDefaults({ projectId: PROJECT }, "jfrog", HOSTS);
    await svc.removeAllBlocklistRules({ projectId: PROJECT }, "jfrog", HOSTS);

    await expect(enforcedHosts(PROJECT)).resolves.toEqual([]);
    const draft = await orderedRules(PROJECT, "draft");
    expect(draft.filter((r) => r.source === "blocklist")).toHaveLength(0);
  });

  it("is idempotent and preserves a user's off-switch across re-seeds", async () => {
    await svc.initBlocklistDefaults({ projectId: PROJECT }, "jfrog", HOSTS);
    const [npm] = await svc.getBlocklistState({ projectId: PROJECT }, "jfrog", [
      NPM,
    ]);
    await svc.toggleBlocklistRule({ projectId: PROJECT }, npm!.ruleId!, false);

    // Re-connecting the app must not silently re-enable a block the user turned
    // off, nor duplicate the rule.
    await svc.initBlocklistDefaults({ projectId: PROJECT }, "jfrog", HOSTS);
    const draft = await orderedRules(PROJECT, "draft");
    expect(draft.filter((r) => r.source === "blocklist")).toHaveLength(2);
    await expect(enforcedHosts(PROJECT)).resolves.not.toContain(
      NPM.hostPattern,
    );
  });

  it("fences to its own scope — another project's block is untouched", async () => {
    await svc.initBlocklistDefaults({ projectId: PROJECT }, "jfrog", [NPM]);
    await svc.initBlocklistDefaults({ projectId: FENCE }, "jfrog", [NPM]);

    const [mine] = await svc.getBlocklistState(
      { projectId: PROJECT },
      "jfrog",
      [NPM],
    );
    // A rule id from another project must not resolve here.
    await expect(
      svc.toggleBlocklistRule({ projectId: FENCE }, mine!.ruleId!, false),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await svc.removeAllBlocklistRules({ projectId: PROJECT }, "jfrog", [NPM]);
    await expect(enforcedHosts(FENCE)).resolves.toContain(NPM.hostPattern);
  });

  it("shows an org-level block on the project page, locked and not toggleable", async () => {
    // The project page passes BOTH ids; an org block applies to every project
    // under it, so it must surface there — and must not be editable from below.
    await svc.initBlocklistDefaults({ organizationId: ORG }, "jfrog", [NPM]);

    const [state] = await svc.getBlocklistState(
      { projectId: PROJECT, organizationId: ORG },
      "jfrog",
      [NPM],
    );
    expect(state).toMatchObject({ enabled: true, scope: "organization" });

    // The panel renders that row locked; the service refuses it anyway.
    await expect(
      svc.toggleBlocklistRule({ projectId: PROJECT }, state!.ruleId!, false),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // ...and the project's own writes still land in the project.
    await svc.initBlocklistDefaults({ projectId: PROJECT }, "jfrog", [PYPI]);
    const [, pypi] = await svc.getBlocklistState(
      { projectId: PROJECT, organizationId: ORG },
      "jfrog",
      [NPM, PYPI],
    );
    expect(pypi).toMatchObject({ enabled: true, scope: "project" });

    await svc.removeAllBlocklistRules({ organizationId: ORG }, "jfrog", [NPM]);
  });

  it("writes draft-only when the scope has never published", async () => {
    // An unseeded scope enforces nothing at all, so a draft-only write is
    // consistent — and the first publish carries the block live.
    await db.policyRuleV2.deleteMany({
      where: { projectId: PROJECT, status: "published" },
    });
    await svc.initBlocklistDefaults({ projectId: PROJECT }, "jfrog", [NPM]);

    const draft = await orderedRules(PROJECT, "draft");
    expect(draft.filter((r) => r.source === "blocklist")).toHaveLength(1);
    const published = await db.policyRuleV2.count({
      where: { projectId: PROJECT, status: "published" },
    });
    expect(published).toBe(0);
  });
});
