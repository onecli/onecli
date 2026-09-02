import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

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

const PROOF_URL = proofDatabaseUrl();

// Dynamic imports: @onecli/db builds its client from DATABASE_URL at import
// time, so the env must be staged first.
type Db = typeof import("@onecli/db").db;
type Service = typeof import("./app-blocklist-service");

let db: Db;
let svc: Service;

const P = "blproof-";
const ORG = `${P}org`;
const WORKSPACE = `${P}proj`;
const FENCE = `${P}fence`;

const NPM = {
  id: "npm",
  name: "npm Registry",
  hostPattern: "registry.npmjs.org",
};
const PYPI = { id: "pypi", name: "PyPI", hostPattern: "pypi.org" };
const HOSTS = [NPM, PYPI];

/** The gateway's own read: published, live generation, enabled only. */
const enforcedHosts = async (workspaceId: string): Promise<string[]> => {
  const live = await db.policyRuleV2.aggregate({
    where: { scope: "workspace", workspaceId, status: "published" },
    _max: { generation: true },
  });
  const rows = await db.policyRuleV2.findMany({
    where: {
      scope: "workspace",
      workspaceId,
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

const orderedRules = async (workspaceId: string, status: string) => {
  const where =
    status === "published"
      ? {
          scope: "workspace" as const,
          workspaceId,
          status,
          generation:
            (
              await db.policyRuleV2.aggregate({
                where: { scope: "workspace", workspaceId, status: "published" },
                _max: { generation: true },
              })
            )._max.generation ?? -1,
        }
      : { scope: "workspace" as const, workspaceId, status };
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
    where: { workspaceId: { in: [WORKSPACE, FENCE] } },
  });
  await db.workspace.deleteMany({ where: { id: { in: [WORKSPACE, FENCE] } } });
  await db.organization.deleteMany({ where: { id: ORG } });
};

/** A workspace that has already published once — the normal state, since every new
 * scope is seeded with a published Default Rule. Carries one `allow` rule so the
 * block's placement (before anything looser) is observable. */
const seedPublishedWorkspace = async (workspaceId: string) => {
  await db.workspace.create({
    data: { id: workspaceId, name: workspaceId, organizationId: ORG },
  });
  for (const [status, generation] of [
    ["draft", 0],
    ["published", 1],
  ] as const) {
    await db.policyRuleV2.create({
      data: {
        scope: "workspace",
        workspaceId,
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
        scope: "workspace",
        workspaceId,
        status,
        generation,
        priority: 1,
        isDefault: false,
        source: "custom",
        logicalId: `${workspaceId}-allow`,
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
    where: { workspaceId: { in: [WORKSPACE, FENCE] } },
  });
  await db.workspace.deleteMany({ where: { id: { in: [WORKSPACE, FENCE] } } });
  await seedPublishedWorkspace(WORKSPACE);
  await seedPublishedWorkspace(FENCE);
});

describe.skipIf(!PROOF_URL)("app blocklist over real PostgreSQL", () => {
  it("a seeded block reaches the generation the gateway enforces", async () => {
    await svc.initBlocklistDefaults({ workspaceId: WORKSPACE }, "jfrog", HOSTS);

    // THE regression: the rule must be in the LIVE PUBLISHED set, not just the
    // draft — a draft-only write is exactly the silent no-op this replaced.
    await expect(enforcedHosts(WORKSPACE)).resolves.toEqual(
      expect.arrayContaining([NPM.hostPattern, PYPI.hostPattern]),
    );

    // ...and in the draft too, so the next publish carries it forward instead of
    // dropping it.
    const draft = await orderedRules(WORKSPACE, "draft");
    expect(draft.filter((r) => r.source === "blocklist")).toHaveLength(2);
  });

  it("places the block BEFORE looser rules in both sets", async () => {
    await svc.initBlocklistDefaults({ workspaceId: WORKSPACE }, "jfrog", [NPM]);
    for (const status of ["draft", "published"]) {
      const rules = await orderedRules(WORKSPACE, status);
      expect(rules.map((r) => r.action)).toEqual(["block", "allow"]);
      expect(rules[0]!.source).toBe("blocklist");
    }
  });

  it("toggling off stops enforcement in the live generation", async () => {
    await svc.initBlocklistDefaults({ workspaceId: WORKSPACE }, "jfrog", [NPM]);
    const [state] = await svc.getBlocklistState(
      { workspaceId: WORKSPACE },
      "jfrog",
      [NPM],
    );
    expect(state!.enabled).toBe(true);

    await svc.toggleBlocklistRule(
      { workspaceId: WORKSPACE },
      state!.ruleId!,
      false,
    );
    await expect(enforcedHosts(WORKSPACE)).resolves.not.toContain(
      NPM.hostPattern,
    );

    await svc.toggleBlocklistRule(
      { workspaceId: WORKSPACE },
      state!.ruleId!,
      true,
    );
    await expect(enforcedHosts(WORKSPACE)).resolves.toContain(NPM.hostPattern);
  });

  it("removing the app's blocks clears both sets", async () => {
    await svc.initBlocklistDefaults({ workspaceId: WORKSPACE }, "jfrog", HOSTS);
    await svc.removeAllBlocklistRules(
      { workspaceId: WORKSPACE },
      "jfrog",
      HOSTS,
    );

    await expect(enforcedHosts(WORKSPACE)).resolves.toEqual([]);
    const draft = await orderedRules(WORKSPACE, "draft");
    expect(draft.filter((r) => r.source === "blocklist")).toHaveLength(0);
  });

  it("is idempotent and preserves a user's off-switch across re-seeds", async () => {
    await svc.initBlocklistDefaults({ workspaceId: WORKSPACE }, "jfrog", HOSTS);
    const [npm] = await svc.getBlocklistState(
      { workspaceId: WORKSPACE },
      "jfrog",
      [NPM],
    );
    await svc.toggleBlocklistRule(
      { workspaceId: WORKSPACE },
      npm!.ruleId!,
      false,
    );

    // Re-connecting the app must not silently re-enable a block the user turned
    // off, nor duplicate the rule.
    await svc.initBlocklistDefaults({ workspaceId: WORKSPACE }, "jfrog", HOSTS);
    const draft = await orderedRules(WORKSPACE, "draft");
    expect(draft.filter((r) => r.source === "blocklist")).toHaveLength(2);
    await expect(enforcedHosts(WORKSPACE)).resolves.not.toContain(
      NPM.hostPattern,
    );
  });

  it("fences to its own scope — another workspace's block is untouched", async () => {
    await svc.initBlocklistDefaults({ workspaceId: WORKSPACE }, "jfrog", [NPM]);
    await svc.initBlocklistDefaults({ workspaceId: FENCE }, "jfrog", [NPM]);

    const [mine] = await svc.getBlocklistState(
      { workspaceId: WORKSPACE },
      "jfrog",
      [NPM],
    );
    // A rule id from another workspace must not resolve here.
    await expect(
      svc.toggleBlocklistRule({ workspaceId: FENCE }, mine!.ruleId!, false),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await svc.removeAllBlocklistRules({ workspaceId: WORKSPACE }, "jfrog", [
      NPM,
    ]);
    await expect(enforcedHosts(FENCE)).resolves.toContain(NPM.hostPattern);
  });

  it("shows an org-level block on the workspace page, locked and not toggleable", async () => {
    // The workspace page passes BOTH ids; an org block applies to every workspace
    // under it, so it must surface there — and must not be editable from below.
    await svc.initBlocklistDefaults({ organizationId: ORG }, "jfrog", [NPM]);

    const [state] = await svc.getBlocklistState(
      { workspaceId: WORKSPACE, organizationId: ORG },
      "jfrog",
      [NPM],
    );
    expect(state).toMatchObject({ enabled: true, scope: "organization" });

    // The panel renders that row locked; the service refuses it anyway.
    await expect(
      svc.toggleBlocklistRule(
        { workspaceId: WORKSPACE },
        state!.ruleId!,
        false,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // ...and the workspace's own writes still land in the workspace.
    await svc.initBlocklistDefaults({ workspaceId: WORKSPACE }, "jfrog", [
      PYPI,
    ]);
    const [, pypi] = await svc.getBlocklistState(
      { workspaceId: WORKSPACE, organizationId: ORG },
      "jfrog",
      [NPM, PYPI],
    );
    expect(pypi).toMatchObject({ enabled: true, scope: "workspace" });

    await svc.removeAllBlocklistRules({ organizationId: ORG }, "jfrog", [NPM]);
  });

  it("writes draft-only when the scope has never published", async () => {
    // An unseeded scope enforces nothing at all, so a draft-only write is
    // consistent — and the first publish carries the block live.
    await db.policyRuleV2.deleteMany({
      where: { workspaceId: WORKSPACE, status: "published" },
    });
    await svc.initBlocklistDefaults({ workspaceId: WORKSPACE }, "jfrog", [NPM]);

    const draft = await orderedRules(WORKSPACE, "draft");
    expect(draft.filter((r) => r.source === "blocklist")).toHaveLength(1);
    const published = await db.policyRuleV2.count({
      where: { workspaceId: WORKSPACE, status: "published" },
    });
    expect(published).toBe(0);
  });
});
