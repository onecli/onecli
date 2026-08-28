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
const WORKSPACE = `${P}proj`;
const OTHER_ORG = `${P}other-org`;
const OTHER_WORKSPACE = `${P}other-proj`;
const AGENT = `${P}agent`;
/** A HOSTED agent — the only kind with a computer a grant has to reach. */
const HOSTED_AGENT = `${P}hosted`;
const RUNNER = `${P}runner`;
const SANDBOX = `${P}sandbox`;
const CONN_WORK = `${P}conn-work`;
const CONN_PERSONAL = `${P}conn-personal`;
const CONN_ORG = `${P}conn-orgshared`;
const CONN_FOREIGN = `${P}conn-foreign`;
const SECRET = `${P}secret`;

const SCOPE = { workspaceId: WORKSPACE, organizationId: ORG };
const GMAIL_HOST = "gmail.googleapis.com";

const reset = async () => {
  await db.policyRuleV2.deleteMany({
    where: {
      OR: [
        { workspaceId: { startsWith: P } },
        { organizationId: { startsWith: P } },
      ],
    },
  });
  await db.appConnection.deleteMany({ where: { id: { startsWith: P } } });
  await db.secret.deleteMany({ where: { id: { startsWith: P } } });
  // Agents cascade their sandboxes and conversations; the runner they sit on
  // does not, so it goes after them.
  await db.agent.deleteMany({ where: { id: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: { startsWith: P } } });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
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
  await db.agent.create({
    data: {
      id: AGENT,
      workspaceId: WORKSPACE,
      name: "grn agent",
      identifier: AGENT,
      accessToken: "aoc_grn_test_token",
    },
  });
  await db.agent.create({
    data: {
      id: HOSTED_AGENT,
      workspaceId: WORKSPACE,
      name: "grn hosted agent",
      identifier: HOSTED_AGENT,
      accessToken: "aoc_grn_hosted_token",
      kind: "hosted",
      harness: "jcode",
    },
  });
  await db.runner.create({
    data: {
      id: RUNNER,
      name: "grn runner",
      token: `rnr_${P}test`,
      capabilities: {
        maxSandboxes: 4,
        backend: "docker",
        homeDurability: "resident",
      },
    },
  });
  const conn = (id: string, over: Record<string, unknown> = {}) =>
    db.appConnection.create({
      data: {
        id,
        provider: "gmail",
        scope: "workspace",
        status: "connected",
        workspaceId: WORKSPACE,
        label: id,
        ...over,
      },
    });
  await conn(CONN_WORK);
  await conn(CONN_PERSONAL);
  await conn(CONN_ORG, {
    scope: "organization",
    workspaceId: null,
    organizationId: ORG,
  });
  await conn(CONN_FOREIGN, { workspaceId: OTHER_WORKSPACE });
  await db.secret.create({
    data: {
      id: SECRET,
      name: "grn secret",
      type: "generic",
      hostPattern: "api.grn.example",
      scope: "workspace",
      workspaceId: WORKSPACE,
    },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.$disconnect();
});

beforeEach(async () => {
  // The compiler is the unit under test — entitlement gating is not. Under
  // the CI cloud env the provider slots fail loudly unless injected, so give
  // every test the permissive defaults this suite always ran with (individual
  // tests that exercise a real validator re-inject their own below).
  const providers = await import("../providers");
  providers.initRuleActionGate({ assertAllowed: async () => {} });
  providers.initPolicyValidator({ validate: async () => {} });
  if (!PROOF_URL) return;
  await db.policyRuleV2.deleteMany({
    where: {
      OR: [
        { workspaceId: { startsWith: P } },
        { organizationId: { startsWith: P } },
      ],
    },
  });
});

/** The engine rules exactly as the reflections read them: published workspace
 * rows → toSimRule (fenced host/provider maps) → the typed evaluator rules. */
const engineRules = async () => {
  const [rows, hosts, providers] = await Promise.all([
    loaders.loadRulesForSimulation(
      { scope: "workspace", workspaceId: WORKSPACE },
      "published",
    ),
    secretHosts.loadSecretHosts(ORG, WORKSPACE),
    connectionProviders.loadConnectionProviders(ORG, WORKSPACE),
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
    where: { workspaceId: WORKSPACE, source: "grant", ...extra },
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
      { scope: "workspace", workspaceId: WORKSPACE },
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
    // SIBLING matches none of the stack and rides the workspace's allow default.
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
      where: { workspaceId: WORKSPACE, status: "published" },
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
      where: { workspaceId: WORKSPACE, status: "published" },
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
      { scope: "workspace", workspaceId: WORKSPACE },
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
      { scope: "workspace", workspaceId: WORKSPACE },
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
        { scope: "workspace", workspaceId: WORKSPACE },
        "draft",
      ),
      loaders.loadRulesForSimulation(
        { scope: "workspace", workspaceId: WORKSPACE },
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

  it("resources tri-state: SET rides every allow row (draft + published), ABSENT preserves, NULL clears", async () => {
    const SORTED = { repositories: ["owner/a", "owner/b"] };
    // SET — deliberately unsorted input: the server normalizes to sorted.
    await grants.setConnectionGrant(
      SCOPE,
      AGENT,
      CONN_WORK,
      {
        access: "custom",
        allow: ["create_draft"],
        ask: ["get_message"],
        resources: { repositories: ["owner/b", "owner/a"] },
      },
      null,
    );
    for (const status of ["draft", "published"] as const) {
      const rows = await grantRows({ status });
      const allowRows = rows.filter((r) => r.action === "allow");
      expect(allowRows.length).toBeGreaterThan(1);
      for (const row of allowRows) {
        expect(JSON.parse(JSON.stringify(row.conditions))).toEqual(SORTED);
      }
    }

    // The read path exposes it in the wire shape.
    const read = await grants.getAgentGrants(SCOPE, AGENT);
    expect(
      read.connections.find((c) => c.connectionId === CONN_WORK)?.resources,
    ).toEqual(SORTED);

    // A same-set re-pick in a different order is the idempotent no-op.
    const reordered = await grants.setConnectionGrant(
      SCOPE,
      AGENT,
      CONN_WORK,
      {
        access: "custom",
        allow: ["create_draft"],
        ask: ["get_message"],
        resources: { repositories: ["owner/b", "owner/a"] },
      },
      null,
    );
    expect(reordered.changed).toBe(false);

    // ABSENT (a tools-only save) preserves the stored restriction.
    await grants.setConnectionGrant(
      SCOPE,
      AGENT,
      CONN_WORK,
      { access: "custom", allow: ["create_draft"], ask: [] },
      null,
    );
    const preserved = await grantRows({ status: "draft" });
    for (const row of preserved.filter((r) => r.action === "allow")) {
      expect(JSON.parse(JSON.stringify(row.conditions))).toEqual(SORTED);
    }

    // NULL clears — every row, and the read path agrees.
    await grants.setConnectionGrant(
      SCOPE,
      AGENT,
      CONN_WORK,
      { access: "custom", allow: ["create_draft"], ask: [], resources: null },
      null,
    );
    const cleared = await grantRows({ status: "draft" });
    expect(cleared.every((r) => r.conditions === null)).toBe(true);
    const readCleared = await grants.getAgentGrants(SCOPE, AGENT);
    expect(
      readCleared.connections.find((c) => c.connectionId === CONN_WORK)
        ?.resources,
    ).toBeNull();
  });

  it("the org boundary bounds what a workspace may select — and narrowing within it saves", async () => {
    // A published ORG rule naming NO identity: the "applies to every agent"
    // shape, which bounds every agent's reach for this connection.
    const orgBase = { scope: "organization", organizationId: ORG };
    const orgRule = async (repositories: string[]) => {
      await db.policyRuleV2.deleteMany({ where: { organizationId: ORG } });
      for (const status of ["draft", "published"] as const) {
        await db.policyRuleV2.create({
          data: {
            ...orgBase,
            status,
            generation: status === "published" ? 1 : 0,
            priority: 1,
            isDefault: false,
            enabled: true,
            source: "custom",
            logicalId: `${P}org-rule`,
            name: "org boundary",
            action: "allow",
            requireApproval: false,
            conditions: { repositories },
            targets: {
              create: [
                {
                  kind: "connection",
                  appConnection: { connect: { id: CONN_WORK } },
                },
              ],
            },
          },
        });
      }
    };
    await orgRule(["org/allowed", "org/also-allowed"]);

    // Outside the boundary → refused, naming the offending entry.
    await expect(
      grants.setConnectionGrant(
        SCOPE,
        AGENT,
        CONN_WORK,
        { access: "full", resources: { repositories: ["org/forbidden"] } },
        null,
      ),
    ).rejects.toThrow(/org\/forbidden/);
    expect(await grantRows({ status: "draft" })).toHaveLength(0);

    // Within it → saved as written; the gateway composes the rest.
    await grants.setConnectionGrant(
      SCOPE,
      AGENT,
      CONN_WORK,
      { access: "full", resources: { repositories: ["org/allowed"] } },
      null,
    );
    const rows = await grantRows({ status: "draft" });
    expect(JSON.parse(JSON.stringify(rows[0]?.conditions))).toEqual({
      repositories: ["org/allowed"],
    });

    // An org edit that narrows below an existing grant leaves the stack alone —
    // runtime composition, not a rewrite, is what enforces the new boundary.
    await orgRule(["org/also-allowed"]);
    const after = await grantRows({ status: "draft" });
    expect(JSON.parse(JSON.stringify(after[0]?.conditions))).toEqual({
      repositories: ["org/allowed"],
    });
    await db.policyRuleV2.deleteMany({ where: { organizationId: ORG } });
  });

  it("an empty resources selection normalizes to null (empty ≡ all)", async () => {
    await grants.setConnectionGrant(
      SCOPE,
      AGENT,
      CONN_WORK,
      { access: "full", resources: { repositories: [] } },
      null,
    );
    const rows = await grantRows({ status: "draft" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.conditions).toBeNull();
  });

  it("an explicit SET runs the edition validator; clear and preserve never do; a rejecting validator blocks the write", async () => {
    const providers = await import("../providers");
    const calls: {
      organizationId: string;
      provider: string;
      policy: unknown;
    }[] = [];
    providers.initPolicyValidator({
      validate: async (organizationId, provider, _metadata, policy) => {
        calls.push({ organizationId, provider, policy });
      },
    });
    try {
      await grants.setConnectionGrant(
        SCOPE,
        AGENT,
        CONN_WORK,
        { access: "full", resources: { repositories: ["owner/a"] } },
        null,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        organizationId: ORG,
        provider: "gmail",
        policy: { repositories: ["owner/a"] },
      });
      // A FULL grant's single allow row carries the set policy too — access
      // stays "full" (conditions don't affect the shape detection).
      const fullRows = await grantRows({ status: "draft" });
      expect(fullRows).toHaveLength(1);
      expect(JSON.parse(JSON.stringify(fullRows[0]?.conditions))).toEqual({
        repositories: ["owner/a"],
      });
      const fullRead = await grants.getAgentGrants(SCOPE, AGENT);
      expect(
        fullRead.connections.find((c) => c.connectionId === CONN_WORK),
      ).toMatchObject({
        access: "full",
        resources: { repositories: ["owner/a"] },
      });

      // Preserve (absent) and clear (null) are never gated.
      await grants.setConnectionGrant(
        SCOPE,
        AGENT,
        CONN_WORK,
        { access: "full" },
        null,
      );
      await grants.setConnectionGrant(
        SCOPE,
        AGENT,
        CONN_WORK,
        { access: "full", resources: null },
        null,
      );
      expect(calls).toHaveLength(1);

      // A rejecting validator (the OSS 422 lock / EE plan gate) blocks the
      // write before anything lands.
      providers.initPolicyValidator({
        validate: async () => {
          throw new Error("locked");
        },
      });
      await expect(
        grants.setConnectionGrant(
          SCOPE,
          AGENT,
          CONN_WORK,
          { access: "full", resources: { repositories: ["owner/a"] } },
          null,
        ),
      ).rejects.toThrow("locked");
      const rows = await grantRows({ status: "draft" });
      expect(rows.every((r) => r.conditions === null)).toBe(true);
    } finally {
      // The permissive default — leave the registry as the suite found it.
      providers.initPolicyValidator({ validate: async () => {} });
    }
  });
});

/**
 * A grant that never reaches the computer is not a grant.
 *
 * The spawn payload names the credential PLACEHOLDER matching the granted
 * secret's auth mode — `ANTHROPIC_API_KEY` for an API key,
 * `CLAUDE_CODE_OAUTH_TOKEN` for an OAuth token — and it is composed at
 * DISPATCH. Nothing used to request a respawn when a grant changed, so
 * granting a key to a RUNNING hosted agent did nothing at all: proven live,
 * where the agent answered `credential_not_found` with the grant in place
 * until an unrelated token regeneration happened to recreate the container.
 */
describe.skipIf(!PROOF_URL)("a grant reaches the sandbox", () => {
  const seedSandbox = (status: string, agentId = HOSTED_AGENT, id = SANDBOX) =>
    db.sandbox.create({
      data: {
        id,
        agentId,
        runnerId: RUNNER,
        status,
        lastActiveAt: new Date(),
      },
    });

  const sandboxStatus = async (id = SANDBOX) =>
    (await db.sandbox.findUnique({ where: { id } }))?.status;

  beforeEach(async () => {
    if (!PROOF_URL) return;
    await db.sandbox.deleteMany({ where: { id: { startsWith: SANDBOX } } });
  });

  it("granting a secret marks a RUNNING sandbox for respawn", async () => {
    await seedSandbox("running");

    await grants.setSecretGrant(SCOPE, HOSTED_AGENT, SECRET, null);

    // `unprovisioned` is what the dispatch seam's start arm claims — the next
    // poll composes a fresh payload and the runner recreates the container.
    expect(await sandboxStatus()).toBe("unprovisioned");
  });

  it("REVOKING a secret marks it for respawn too", async () => {
    await grants.setSecretGrant(SCOPE, HOSTED_AGENT, SECRET, null);
    await seedSandbox("running");

    await grants.removeSecretGrant(SCOPE, HOSTED_AGENT, SECRET, null);

    // Losing the only OAuth secret flips the placeholder back to
    // `ANTHROPIC_API_KEY`; a container still advertising the old one would go
    // on sending a header the gateway no longer fills.
    expect(await sandboxStatus()).toBe("unprovisioned");
  });

  it("an idempotent no-op grant does NOT recreate the container", async () => {
    await grants.setSecretGrant(SCOPE, HOSTED_AGENT, SECRET, null);
    await seedSandbox("running");

    const again = await grants.setSecretGrant(
      SCOPE,
      HOSTED_AGENT,
      SECRET,
      null,
    );

    expect(again.changed).toBe(false);
    expect(await sandboxStatus()).toBe("running");
  });

  it("a CONNECTION grant leaves the container alone", async () => {
    // Nothing about a connection reaches the container: the gateway splices
    // those credentials at the wire, so the spawn payload is byte-identical
    // before and after. Respawning would destroy a live session to change
    // nothing — the planted negative control for the fix above.
    await seedSandbox("running");

    await grants.setConnectionGrant(
      SCOPE,
      HOSTED_AGENT,
      CONN_WORK,
      { access: "full" },
      null,
    );

    expect(await sandboxStatus()).toBe("running");
  });

  it("a BYO agent's grant recreates nothing — planted negative control", async () => {
    // A byo agent brings its own computer, so a grant has nowhere to land. The
    // sandbox row here is PLANTED — nothing creates one for a byo agent — so
    // that the `kind` guard is what the assertion rests on rather than the
    // absence of a row, which would pass with the guard deleted.
    await seedSandbox("running", AGENT, `${SANDBOX}-byo`);

    const set = await grants.setSecretGrant(SCOPE, AGENT, SECRET, null);

    expect(set.changed).toBe(true);
    expect(await sandboxStatus(`${SANDBOX}-byo`)).toBe("running");
  });
});
