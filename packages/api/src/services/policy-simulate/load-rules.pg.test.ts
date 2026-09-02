import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../../testing/pg-proof.js";

/**
 * The two rule loaders on REAL PostgreSQL.
 *
 * `loadRulesForSimulation` (DECISION) and `loadInjectionRules` (INJECTION)
 * differ by ONE `where` term, and reading the wrong one is silent: the decision
 * set quietly gains a permission nothing granted, or a selective agent's
 * credentials quietly vanish from every reflection. Both are settled here
 * against real rows rather than an assertion about a mock's arguments.
 *
 * Also pins the terms both share — `enabled`, the published-generation pin, and
 * the scope fence — at BOTH scopes, since the org and workspace loads take the
 * same code path but only the workspace one had any coverage.
 *
 * Env-gated like the other proof suites; see app-blocklist-service.pg.test.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Loaders = typeof import("./load-rules");

let db: Db;
let loaders: Loaders;

const P = "ldr-";
const ORG = `${P}org`;
const WORKSPACE = `${P}proj`;
const OTHER_ORG = `${P}other-org`;
const OTHER_WORKSPACE = `${P}other-proj`;

const ORG_BASE = { scope: "organization" as const, organizationId: ORG };
const WORKSPACE_BASE = { scope: "workspace" as const, workspaceId: WORKSPACE };

const rule = async (
  logicalId: string,
  over: Partial<{
    scope: "organization" | "workspace";
    workspaceId: string | null;
    organizationId: string | null;
    status: "draft" | "published";
    generation: number;
    priority: number;
    source: string;
    enabled: boolean;
    action: string;
  }> = {},
) => {
  const scope = over.scope ?? "workspace";
  await db.policyRuleV2.create({
    data: {
      scope,
      workspaceId:
        over.workspaceId === undefined
          ? scope === "workspace"
            ? WORKSPACE
            : null
          : over.workspaceId,
      organizationId:
        over.organizationId === undefined
          ? scope === "organization"
            ? ORG
            : null
          : over.organizationId,
      status: over.status ?? "published",
      generation: over.generation ?? 1,
      priority: over.priority ?? 10,
      isDefault: false,
      enabled: over.enabled ?? true,
      source: over.source ?? "custom",
      logicalId,
      name: logicalId,
      action: over.action ?? "allow",
      requireApproval: false,
    },
  });
};

const ids = (rows: { logicalId: string }[]) =>
  rows.map((r) => r.logicalId).sort();

const reset = async () => {
  await db.policyRuleV2.deleteMany({ where: { logicalId: { startsWith: P } } });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  loaders = await import("./load-rules");
  await reset();
  for (const id of [ORG, OTHER_ORG]) {
    await db.organization.create({ data: { id, name: id, slug: id } });
  }
  await db.workspace.create({
    data: { id: WORKSPACE, name: WORKSPACE, organizationId: ORG },
  });
  await db.workspace.create({
    data: {
      id: OTHER_WORKSPACE,
      name: OTHER_WORKSPACE,
      organizationId: OTHER_ORG,
    },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.$disconnect();
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await db.policyRuleV2.deleteMany({ where: { logicalId: { startsWith: P } } });
});

describe.skipIf(!PROOF_URL)(
  "the decision/injection split over real PostgreSQL",
  () => {
    it("DECISION drops equipment; INJECTION keeps it — same rows, same scope", async () => {
      // The whole point of the split. An equipment rule grants a credential
      // WITHOUT permitting its host: visible to inject_select, invisible to
      // assemble_v2.
      await rule(`${P}custom`);
      await rule(`${P}equip`, { source: "equipment" });
      await rule(`${P}blocklist`, { source: "blocklist", action: "block" });

      await expect(
        loaders.loadRulesForSimulation(WORKSPACE_BASE, "published").then(ids),
      ).resolves.toEqual([`${P}blocklist`, `${P}custom`]);
      await expect(
        loaders.loadInjectionRules(WORKSPACE_BASE, "published").then(ids),
      ).resolves.toEqual([`${P}blocklist`, `${P}custom`, `${P}equip`]);
    });

    it("both loaders drop disabled rows — at BOTH scopes", async () => {
      await rule(`${P}p-on`);
      await rule(`${P}p-off`, { enabled: false });
      await rule(`${P}p-equip-off`, { source: "equipment", enabled: false });
      await rule(`${P}o-on`, { scope: "organization" });
      await rule(`${P}o-off`, { scope: "organization", enabled: false });

      await expect(
        loaders.loadRulesForSimulation(WORKSPACE_BASE, "published").then(ids),
      ).resolves.toEqual([`${P}p-on`]);
      await expect(
        loaders.loadInjectionRules(WORKSPACE_BASE, "published").then(ids),
      ).resolves.toEqual([`${P}p-on`]);
      await expect(
        loaders.loadRulesForSimulation(ORG_BASE, "published").then(ids),
      ).resolves.toEqual([`${P}o-on`]);
      await expect(
        loaders.loadInjectionRules(ORG_BASE, "published").then(ids),
      ).resolves.toEqual([`${P}o-on`]);
    });

    it("published pins to the LATEST generation, never a superseded one", async () => {
      await rule(`${P}gen1`, { generation: 1 });
      await rule(`${P}gen2`, { generation: 2 });
      await rule(`${P}gen2-equip`, { generation: 2, source: "equipment" });
      // A draft row never rides along with the published set.
      await rule(`${P}draft`, { status: "draft", generation: 3 });

      await expect(
        loaders.loadRulesForSimulation(WORKSPACE_BASE, "published").then(ids),
      ).resolves.toEqual([`${P}gen2`]);
      await expect(
        loaders.loadInjectionRules(WORKSPACE_BASE, "published").then(ids),
      ).resolves.toEqual([`${P}gen2`, `${P}gen2-equip`]);
      await expect(
        loaders.loadRulesForSimulation(WORKSPACE_BASE, "draft").then(ids),
      ).resolves.toEqual([`${P}draft`]);
    });

    it("a never-published scope loads nothing — not the draft, not everything", async () => {
      await rule(`${P}draft-only`, { status: "draft" });
      await expect(
        loaders.loadRulesForSimulation(WORKSPACE_BASE, "published").then(ids),
      ).resolves.toEqual([]);
      await expect(
        loaders.loadInjectionRules(WORKSPACE_BASE, "published").then(ids),
      ).resolves.toEqual([]);
    });

    it("SCOPE FENCE: another org's and another workspace's rows never load", async () => {
      await rule(`${P}mine`);
      await rule(`${P}foreign-proj`, { workspaceId: OTHER_WORKSPACE });
      await rule(`${P}org-mine`, { scope: "organization" });
      await rule(`${P}org-foreign`, {
        scope: "organization",
        organizationId: OTHER_ORG,
      });

      await expect(
        loaders.loadRulesForSimulation(WORKSPACE_BASE, "published").then(ids),
      ).resolves.toEqual([`${P}mine`]);
      await expect(
        loaders.loadInjectionRules(ORG_BASE, "published").then(ids),
      ).resolves.toEqual([`${P}org-mine`]);
    });

    it("first-match order is priority then id — the gateway's own ordering", async () => {
      await rule(`${P}c`, { priority: 30 });
      await rule(`${P}a`, { priority: 10 });
      await rule(`${P}b`, { priority: 20 });
      const rows = await loaders.loadRulesForSimulation(
        WORKSPACE_BASE,
        "published",
      );
      expect(rows.map((r) => r.logicalId)).toEqual([`${P}a`, `${P}b`, `${P}c`]);
    });
  },
);
