import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * The grant compiler on REAL PostgreSQL — "the write lands somewhere the
 * engine reads". Every law is asserted through the same read path the
 * reflections use (loadRulesForSimulation → toSimRule → evaluateNew), so a
 * grant that compiled into the wrong shape fails here rather than surfacing as
 * a security answer in production: attach injects and decides via the winner,
 * the tri-state enforces per tool, a same-provider sibling sails past (the
 * step-1 winner-binding), detach goes inert, writes are idempotent, hand-edit
 * drift repairs on the next write, org-shared connections attach (the grants
 * fence deliberately differs from assertTargetsValid), and a foreign org's
 * connection is unreachable (the planted cross-org control).
 *
 * Env-gated like the other proof suites; see load-rules.pg.test.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Grants = typeof import("./grants-service");
type Loaders = typeof import("./policy-simulate/load-rules");
type SimRule = typeof import("./policy-simulate/sim-rule");
type Hosts = typeof import("./policy-simulate/secret-hosts");
type Providers = typeof import("./policy-simulate/connection-providers");
type Evaluator = typeof import("./policy-translation/evaluator");

let db: Db;
let grants: Grants;
let loaders: Loaders;
let simRule: SimRule;
let secretHosts: Hosts;
let connectionProviders: Providers;
let evaluator: Evaluator;

const P = "grn-";
const ORG = `${P}org`;
const PROJECT = `${P}proj`;
const OTHER_ORG = `${P}other-org`;
const OTHER_PROJECT = `${P}other-proj`;
const AGENT = `${P}agent`;
const CONN_WORK = `${P}conn-work`;
const CONN_PERSONAL = `${P}conn-personal`;
const CONN_ORG = `${P}conn-orgshared`;
const CONN_FOREIGN = `${P}conn-foreign`;
const SECRET = `${P}secret`;

const SCOPE = { projectId: PROJECT, organizationId: ORG };
const GMAIL_HOST = "gmail.googleapis.com";

const reset = async () => {
  await db.policyRuleV2.deleteMany({
    where: {
      OR: [
        { projectId: { startsWith: P } },
        { organizationId: { startsWith: P } },
      ],
    },
  });
  await db.appConnection.deleteMany({ where: { id: { startsWith: P } } });
  await db.secret.deleteMany({ where: { id: { startsWith: P } } });
  await db.agent.deleteMany({ where: { id: { startsWith: P } } });
  await db.project.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  grants = await import("./grants-service");
  loaders = await import("./policy-simulate/load-rules");
  simRule = await import("./policy-simulate/sim-rule");
  secretHosts = await import("./policy-simulate/secret-hosts");
  connectionProviders = await import("./policy-simulate/connection-providers");
  evaluator = await import("./policy-translation/evaluator");
  await reset();

  for (const id of [ORG, OTHER_ORG]) {
    await db.organization.create({ data: { id, name: id, slug: id } });
  }
  await db.project.create({
    data: { id: PROJECT, name: PROJECT, organizationId: ORG },
  });
  await db.project.create({
    data: { id: OTHER_PROJECT, name: OTHER_PROJECT, organizationId: OTHER_ORG },
  });
  await db.agent.create({
    data: {
      id: AGENT,
      projectId: PROJECT,
      name: "grn agent",
      identifier: AGENT,
      accessToken: "aoc_grn_test_token",
      secretMode: "selective",
    },
  });
  const conn = (id: string, over: Record<string, unknown> = {}) =>
    db.appConnection.create({
      data: {
        id,
        provider: "gmail",
        scope: "project",
        status: "connected",
        projectId: PROJECT,
        label: id,
        ...over,
      },
    });
  await conn(CONN_WORK);
  await conn(CONN_PERSONAL);
  await conn(CONN_ORG, {
    scope: "organization",
    projectId: null,
    organizationId: ORG,
  });
  await conn(CONN_FOREIGN, { projectId: OTHER_PROJECT });
  await db.secret.create({
    data: {
      id: SECRET,
      name: "grn secret",
      type: "generic",
      hostPattern: "api.grn.example",
      scope: "project",
      projectId: PROJECT,
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
  await db.policyRuleV2.deleteMany({
    where: {
      OR: [
        { projectId: { startsWith: P } },
        { organizationId: { startsWith: P } },
      ],
    },
  });
});

/** The engine rules exactly as the reflections read them: published project
 * rows → toSimRule (fenced host/provider maps) → the typed evaluator rules. */
const engineRules = async () => {
  const [rows, hosts, providers] = await Promise.all([
    loaders.loadRulesForSimulation(
      { scope: "project", projectId: PROJECT },
      "published",
    ),
    secretHosts.loadSecretHosts(ORG, PROJECT),
    connectionProviders.loadConnectionProviders(ORG, PROJECT),
  ]);
  return rows.map((r) => simRule.toSimRule(r, hosts, providers).rule);
};

const decide = async (opts: {
  path: string;
  method: string;
  winner?: string;
}) => {
  const rules = await engineRules();
  return evaluator.evaluateNew(rules, {
    host: GMAIL_HOST,
    path: opts.path,
    method: opts.method,
    agentId: AGENT,
    hasInjections: true,
    isLlmHost: false,
    winningConnectionId: opts.winner,
  });
};

const grantRows = (extra: Record<string, unknown> = {}) =>
  db.policyRuleV2.findMany({
    where: { projectId: PROJECT, source: "grant", ...extra },
    include: { identities: true, targets: true },
    orderBy: [{ status: "asc" }, { priority: "asc" }],
  });

describe.skipIf(!PROOF_URL)("grant compiler over real PostgreSQL", () => {
  it("full attach: one whole-app allow rule that decides via the winner and injects", async () => {
    const result = await grants.setConnectionGrant(
      SCOPE,
      AGENT,
      CONN_WORK,
      { access: "full" },
      null,
    );
    expect(result.changed).toBe(true);
    expect(result.generation).not.toBeNull();

    const rows = await grantRows({ status: "draft" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.identities[0]?.agentId).toBe(AGENT);
    expect(rows[0]?.targets[0]?.appConnectionId).toBe(CONN_WORK);
    expect(rows[0]?.targets[0]?.appTools).toEqual([]);

    // Decides on the provider's catalog surface — via THIS winner only.
    const viaWork = await decide({
      path: "/gmail/v1/users/me/drafts",
      method: "POST",
      winner: CONN_WORK,
    });
    expect(viaWork.action).toBe("allow");
    expect(viaWork.byDefault).toBeFalsy();

    // The injection read (equipment kept) carries the grant too.
    const injectRows = await loaders.loadInjectionRules(
      { scope: "project", projectId: PROJECT },
      "published",
    );
    expect(
      injectRows.some(
        (r) =>
          r.source === "grant" &&
          r.targets.some((t) => t.appConnectionId === CONN_WORK),
      ),
    ).toBe(true);
  });

  it("custom tri-state: allow / ask / blocked-complement / terminal, bound to the winner", async () => {
    await grants.setConnectionGrant(
      SCOPE,
      AGENT,
      CONN_WORK,
      {
        access: "custom",
        allow: ["create_draft"],
        ask: ["batch_delete_messages"],
      },
      null,
    );

    const draft = await grantRows({ status: "draft" });
    expect(draft).toHaveLength(4);

    const allowed = await decide({
      path: "/gmail/v1/users/me/drafts",
      method: "POST",
      winner: CONN_WORK,
    });
    expect(allowed).toMatchObject({ action: "allow" });
    expect(allowed.requireApproval).toBeFalsy();

    const asked = await decide({
      path: "/gmail/v1/users/me/messages/batchDelete",
      method: "POST",
      winner: CONN_WORK,
    });
    expect(asked).toMatchObject({ action: "allow", requireApproval: true });

    // Any other endpoint of the provider dies on the blocked complement or the
    // terminal — an EXPLICIT block, not a default.
    const blocked = await decide({
      path: "/gmail/v1/users/me/messages",
      method: "GET",
      winner: CONN_WORK,
    });
    expect(blocked.action).toBe("block");
    expect(blocked.byDefault).toBeFalsy();

    // The step-1 winner-binding: the same request via the same-provider
    // SIBLING matches none of the stack and rides the project's allow default.
    const viaSibling = await decide({
      path: "/gmail/v1/users/me/messages",
      method: "GET",
      winner: CONN_PERSONAL,
    });
    expect(viaSibling.action).toBe("allow");
  });

  it("is idempotent: an identical PUT keeps rows and generation byte-stable", async () => {
    await grants.setConnectionGrant(
      SCOPE,
      AGENT,
      CONN_WORK,
      { access: "custom", allow: ["create_draft"], ask: [] },
      null,
    );
    const before = await grantRows();
    const genBefore = await db.policyRuleV2.aggregate({
      where: { projectId: PROJECT, status: "published" },
      _max: { generation: true },
    });

    const second = await grants.setConnectionGrant(
      SCOPE,
      AGENT,
      CONN_WORK,
      { access: "custom", allow: ["create_draft"], ask: [] },
      null,
    );
    expect(second.changed).toBe(false);

    const after = await grantRows();
    expect(after.map((r) => r.id).sort()).toEqual(
      before.map((r) => r.id).sort(),
    );
    const genAfter = await db.policyRuleV2.aggregate({
      where: { projectId: PROJECT, status: "published" },
      _max: { generation: true },
    });
    expect(genAfter._max.generation).toBe(genBefore._max.generation);
  });

  it("repairs hand-edit drift on the next write", async () => {
    await grants.setConnectionGrant(
      SCOPE,
      AGENT,
      CONN_WORK,
      { access: "full" },
      null,
    );
    const [row] = await grantRows({ status: "draft" });
    await db.policyRuleV2.update({
      where: { id: row?.id ?? "" },
      data: { action: "block", name: "hand-edited" },
    });

    const repaired = await grants.setConnectionGrant(
      SCOPE,
      AGENT,
      CONN_WORK,
      { access: "full" },
      null,
    );
    expect(repaired.changed).toBe(true);
    const rows = await grantRows({ status: "draft" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("allow");
  });

  it("detach deletes the stack, publishes, and the tools go inert", async () => {
    await grants.setConnectionGrant(
      SCOPE,
      AGENT,
      CONN_WORK,
      { access: "custom", allow: ["create_draft"], ask: [] },
      null,
    );
    const detach = await grants.removeConnectionGrant(
      SCOPE,
      AGENT,
      CONN_WORK,
      null,
    );
    expect(detach.changed).toBe(true);
    // Draft clean; older published GENERATIONS retain copies by design
    // (rollback retention — the gateway reads only max generation), so the
    // published truth is asserted through the max-generation loader below.
    expect(await grantRows({ status: "draft" })).toHaveLength(0);
    const published = await loaders.loadRulesForSimulation(
      { scope: "project", projectId: PROJECT },
      "published",
    );
    expect(published.filter((r) => r.source === "grant")).toHaveLength(0);

    // The stack (including its terminal block) is gone — back to the default.
    const after = await decide({
      path: "/gmail/v1/users/me/drafts",
      method: "POST",
      winner: CONN_WORK,
    });
    expect(after.action).toBe("allow");
  });

  it("attaches an ORG-SHARED connection (the grants fence permits what assertTargetsValid forbids)", async () => {
    const result = await grants.setConnectionGrant(
      SCOPE,
      AGENT,
      CONN_ORG,
      { access: "full" },
      null,
    );
    expect(result.changed).toBe(true);
    expect(
      result.grants.connections.find((c) => c.connectionId === CONN_ORG)?.scope,
    ).toBe("organization");
  });

  it("cross-org negative control: a foreign org's connection is NOT_FOUND", async () => {
    await expect(
      grants.setConnectionGrant(
        SCOPE,
        AGENT,
        CONN_FOREIGN,
        { access: "full" },
        null,
      ),
    ).rejects.toThrow("Connection not found");
    expect(await grantRows()).toHaveLength(0);
  });

  it("secret grants: single allow rule, listed on the agent, detachable", async () => {
    const set = await grants.setSecretGrant(SCOPE, AGENT, SECRET, null);
    expect(set.changed).toBe(true);
    expect(set.grants.secrets.map((s) => s.secretId)).toEqual([SECRET]);
    const rows = await grantRows({ status: "draft" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targets[0]?.secretId).toBe(SECRET);

    const removed = await grants.removeSecretGrant(SCOPE, AGENT, SECRET, null);
    expect(removed.changed).toBe(true);
    expect(await grantRows({ status: "draft" })).toHaveLength(0);
    const published = await loaders.loadRulesForSimulation(
      { scope: "project", projectId: PROJECT },
      "published",
    );
    expect(published.filter((r) => r.source === "grant")).toHaveLength(0);
  });

  it("draft and published grant sets stay in lockstep (atomic publish)", async () => {
    await grants.setConnectionGrant(
      SCOPE,
      AGENT,
      CONN_WORK,
      { access: "full" },
      null,
    );
    const [draftRows, publishedRows] = await Promise.all([
      loaders.loadRulesForSimulation(
        { scope: "project", projectId: PROJECT },
        "draft",
      ),
      loaders.loadRulesForSimulation(
        { scope: "project", projectId: PROJECT },
        "published",
      ),
    ]);
    const grantIds = (rows: { source: string; logicalId: string }[]) =>
      rows
        .filter((r) => r.source === "grant")
        .map((r) => r.logicalId)
        .sort();
    expect(grantIds(publishedRows)).toEqual(grantIds(draftRows));
    expect(grantIds(draftRows).length).toBeGreaterThan(0);
  });

  it("a carried session policy survives dialog re-saves — on EVERY allow row — and stays idempotent", async () => {
    // The step-5 converter parks session policies on grant stacks (the dialog
    // cannot author one). Pre-fix, a re-save silently dropped the restriction
    // and the conditions defeated stackEquals' idempotence — both pinned here.
    const POLICY = { repositories: ["owner/repo"] };
    await grants.setConnectionGrant(
      SCOPE,
      AGENT,
      CONN_WORK,
      { access: "full" },
      null,
    );
    const seeded = await grantRows({ status: "draft" });
    await db.policyRuleV2.update({
      where: { id: seeded[0]?.id ?? "" },
      data: { conditions: POLICY },
    });

    // Re-save with a DIFFERENT shape: the recompiled stack re-carries the
    // policy on every allow-action row instead of dropping it.
    await grants.setConnectionGrant(
      SCOPE,
      AGENT,
      CONN_WORK,
      { access: "custom", allow: ["create_draft"], ask: ["get_message"] },
      null,
    );
    const custom = await grantRows({ status: "draft" });
    const allowRows = custom.filter((r) => r.action === "allow");
    expect(allowRows.length).toBeGreaterThan(1);
    for (const row of allowRows) {
      expect(JSON.parse(JSON.stringify(row.conditions))).toEqual(POLICY);
    }
    expect(
      custom
        .filter((r) => r.action === "block")
        .every((r) => r.conditions === null),
    ).toBe(true);

    // An identical re-save is the idempotent no-op — the conditions compare
    // (SQL NULL ≡ jsonb null, key-sorted) must not defeat stackEquals.
    const again = await grants.setConnectionGrant(
      SCOPE,
      AGENT,
      CONN_WORK,
      { access: "custom", allow: ["create_draft"], ask: ["get_message"] },
      null,
    );
    expect(again.changed).toBe(false);
  });
});
