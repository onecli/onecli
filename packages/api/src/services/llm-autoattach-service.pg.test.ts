import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

// Pinned onprem: the end-to-end cases below run the real createAgent (default
// kind byo) against an unstamped org, which the cloud creation-world gate
// (§3.10 re-decided 2026-08-23) would refuse under the CI job's ambient cloud
// edition. The gate's own matrix lives in agent-service{,.pg}.test.ts.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

/**
 * The LLM auto-attach on REAL PostgreSQL — "a new agent can actually run".
 *
 * Asserted through the real grant compiler and the real credential resolver
 * (`resolveAgentLlmCredential`, the gateway's own predicate), never a
 * re-derivation: "attached" here means exactly what the gateway will mean at
 * request time, which is the whole point of the feature.
 *
 * The laws, each with its planted negative control:
 *  - LLM keys attach at creation; a GENERIC secret never does (the
 *    fail-closed default must survive the convenience).
 *  - The attach is idempotent — re-running writes nothing.
 *  - A key created later reaches only agents holding NO key; an agent
 *    someone deliberately pointed at a key is never re-pointed.
 *  - The org/workspace fence holds: a foreign workspace's key attaches to
 *    nothing.
 *
 * Env-gated like the other proof suites; see load-rules.pg.test.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type AutoAttach = typeof import("./llm-autoattach-service");
type Grants = typeof import("./grants-service");
type LlmCredential = typeof import("./llm-credential-service");
type Agents = typeof import("./agent-service");
type Secrets = typeof import("./secret-service");

let db: Db;
let autoAttach: AutoAttach;
let grants: Grants;
let llm: LlmCredential;
let agentService: Agents;
let secretService: Secrets;

const P = "laa-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const OTHER_ORG = `${P}other-org`;
const OTHER_WORKSPACE = `${P}other-ws`;
const AGENT = `${P}agent`;
const AGENT_2 = `${P}agent-2`;
const ANTHROPIC = `${P}anthropic`;
const OPENAI = `${P}openai`;
const GENERIC = `${P}generic`;
/** Planted cross-tenant control: another org's key, never attachable here. */
const FOREIGN_KEY = `${P}foreign-key`;

const SCOPE = { workspaceId: WORKSPACE, organizationId: ORG };

const reset = async () => {
  await db.policyRuleV2.deleteMany({
    where: {
      OR: [
        { workspaceId: { startsWith: P } },
        { organizationId: { startsWith: P } },
      ],
    },
  });
  await db.secret.deleteMany({
    where: { OR: [{ id: { startsWith: P } }, { workspaceId: WORKSPACE }] },
  });
  await db.agent.deleteMany({
    where: { OR: [{ id: { startsWith: P } }, { workspaceId: WORKSPACE }] },
  });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

const makeAgent = (id: string, workspaceId = WORKSPACE) =>
  db.agent.create({
    data: {
      id,
      workspaceId,
      name: id,
      identifier: id,
      accessToken: `aoc_${id}_token`,
    },
  });

const makeSecret = (
  id: string,
  type: string,
  over: Record<string, unknown> = {},
) =>
  db.secret.create({
    data: {
      id,
      name: id,
      type,
      hostPattern: type === "openai" ? "api.openai.com" : "api.anthropic.com",
      scope: "workspace",
      workspaceId: WORKSPACE,
      valueSource: "inline",
      // A readable value, so the resolver answers as it would in production.
      encryptedValue: `enc:${id}`,
      ...over,
    },
  });

/** What the agent holds, read back through the grants surface. */
const attached = async (agentId: string) =>
  (await grants.getAgentGrants(SCOPE, agentId)).secrets
    .map((s) => s.secretId)
    .sort();

/** What the GATEWAY would resolve for this agent — the claim that matters. */
const resolved = async (agentId: string) =>
  (
    await llm.resolveAgentLlmCredential(
      { id: agentId, workspaceId: WORKSPACE },
      ORG,
    )
  )?.secretId ?? null;

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  autoAttach = await import("./llm-autoattach-service");
  grants = await import("./grants-service");
  llm = await import("./llm-credential-service");
  agentService = await import("./agent-service");
  secretService = await import("./secret-service");
  // createSecret encrypts through the crypto provider; the local AES arm is
  // what a self-host runs, so the end-to-end tests exercise a real value.
  const providers = await import("../providers");
  providers.initCrypto({
    encrypt: async (v: string) => `enc:${v}`,
    decrypt: async (v: string) => v.replace(/^enc:/, ""),
  });
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
  await db.secret.deleteMany({
    where: { OR: [{ id: { startsWith: P } }, { workspaceId: WORKSPACE }] },
  });
  await db.agent.deleteMany({
    where: { OR: [{ id: { startsWith: P } }, { workspaceId: WORKSPACE }] },
  });
});

describe.skipIf(!PROOF_URL)("LLM auto-attach over real PostgreSQL", () => {
  it("a new agent gets every LLM key — and the gateway agrees it can run", async () => {
    await makeSecret(ANTHROPIC, "anthropic");
    await makeSecret(OPENAI, "openai");
    await makeAgent(AGENT);

    const { secretIds } = await autoAttach.autoAttachLlmKeys(
      WORKSPACE,
      AGENT,
      null,
    );

    expect(secretIds.sort()).toEqual([ANTHROPIC, OPENAI].sort());
    expect(await attached(AGENT)).toEqual([ANTHROPIC, OPENAI].sort());
    // The claim that matters: not "a row exists" but "the gateway resolves a
    // credential" — the exact question that used to answer null and 401.
    expect(await resolved(AGENT)).not.toBeNull();
  });

  it("a GENERIC secret is never auto-attached — planted negative control", async () => {
    await makeSecret(GENERIC, "generic", { hostPattern: "api.example.com" });
    await makeAgent(AGENT);

    const { secretIds } = await autoAttach.autoAttachLlmKeys(
      WORKSPACE,
      AGENT,
      null,
    );

    expect(secretIds).toEqual([]);
    expect(await attached(AGENT)).toEqual([]);
  });

  it("is idempotent — a second run writes no new rules", async () => {
    await makeSecret(ANTHROPIC, "anthropic");
    await makeAgent(AGENT);
    await autoAttach.autoAttachLlmKeys(WORKSPACE, AGENT, null);
    const before = await db.policyRuleV2.findMany({
      where: { workspaceId: WORKSPACE, source: "grant" },
      select: { id: true },
      orderBy: { id: "asc" },
    });

    await autoAttach.autoAttachLlmKeys(WORKSPACE, AGENT, null);

    const after = await db.policyRuleV2.findMany({
      where: { workspaceId: WORKSPACE, source: "grant" },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    expect(after).toEqual(before);
  });

  it("a key added later reaches only the agents holding none", async () => {
    await makeSecret(ANTHROPIC, "anthropic");
    await makeSecret(OPENAI, "openai");
    await makeAgent(AGENT);
    await makeAgent(AGENT_2);
    // AGENT is deliberately pointed at one key; AGENT_2 holds nothing.
    await grants.setSecretGrant(SCOPE, AGENT, ANTHROPIC, null);

    const { agentIds } = await autoAttach.attachLlmKeyToKeylessAgents(
      WORKSPACE,
      OPENAI,
      null,
    );

    expect(agentIds).toEqual([AGENT_2]);
    // The deliberate choice survives untouched — no silent widening.
    expect(await attached(AGENT)).toEqual([ANTHROPIC]);
    expect(await attached(AGENT_2)).toEqual([OPENAI]);
  });

  it("a generic secret created later attaches to nobody", async () => {
    await makeSecret(GENERIC, "generic", { hostPattern: "api.example.com" });
    await makeAgent(AGENT);

    const { agentIds } = await autoAttach.attachLlmKeyToKeylessAgents(
      WORKSPACE,
      GENERIC,
      null,
    );

    expect(agentIds).toEqual([]);
    expect(await attached(AGENT)).toEqual([]);
  });

  it("the tenant fence holds: a foreign org's key attaches to nothing", async () => {
    // The cross-tenant control. Both entry points are fenced by the same
    // org+workspace pool every hand-made grant passes, so a key belonging to
    // another org must be invisible here — not merely unattached.
    await db.secret.create({
      data: {
        id: FOREIGN_KEY,
        name: FOREIGN_KEY,
        type: "anthropic",
        hostPattern: "api.anthropic.com",
        scope: "workspace",
        workspaceId: OTHER_WORKSPACE,
        valueSource: "inline",
        encryptedValue: "enc:foreign",
      },
    });
    await makeAgent(AGENT);

    const later = await autoAttach.attachLlmKeyToKeylessAgents(
      WORKSPACE,
      FOREIGN_KEY,
      null,
    );
    const atCreate = await autoAttach.autoAttachLlmKeys(WORKSPACE, AGENT, null);

    expect(later.agentIds).toEqual([]);
    expect(atCreate.secretIds).toEqual([]);
    expect(await attached(AGENT)).toEqual([]);
    expect(await resolved(AGENT)).toBeNull();
  });

  // ── End-to-end, through the real creation services ───────────────────────
  //
  // The hooks live in the SERVICES, not the routes, so the equip guarantee
  // holds for every caller of the create services (secrets still arrive from
  // two surfaces — the /v1 routes and the web server actions, onboarding's
  // first Anthropic key among them). These two assert the user-visible
  // outcome at that seam: after the ordinary create call, does the gateway
  // resolve a credential?

  it("createAgent equips the agent it just made", async () => {
    await makeSecret(ANTHROPIC, "anthropic");

    const created = await agentService.createAgent(WORKSPACE, {
      name: "E2E agent",
      identifier: `${P}e2e`,
    });

    expect(created.llmKeys).toEqual([ANTHROPIC]);
    expect(await resolved(created.id)).toBe(ANTHROPIC);
  });

  it("createSecret equips the agents that were waiting for a key", async () => {
    // The onboarding order, end to end: the agent exists and cannot run, then
    // the first key arrives and it can.
    await makeAgent(AGENT);
    expect(await resolved(AGENT)).toBeNull();

    const secret = await secretService.createSecret(
      { workspaceId: WORKSPACE },
      {
        name: "Anthropic API Key",
        type: "anthropic",
        value: "sk-ant-e2e",
        hostPattern: "api.anthropic.com",
      },
    );

    expect(secret.attachedAgents).toEqual([AGENT]);
    expect(await resolved(AGENT)).toBe(secret.id);
  });

  it("records an audit row for the grants it made, with no secret value", async () => {
    // Every other grant write is audited; an automatic one must be findable
    // too ("who gave this agent that key?"). Ids and names only.
    const userId = `${P}user`;
    await db.user.create({
      data: {
        id: userId,
        email: `${userId}@example.com`,
        name: "Auditor",
        externalAuthId: userId,
      },
    });
    await makeSecret(ANTHROPIC, "anthropic");
    await makeAgent(AGENT);
    try {
      await autoAttach.autoAttachLlmKeys(WORKSPACE, AGENT, userId);

      const rows = await db.auditLog.findMany({
        where: { workspaceId: WORKSPACE, service: "grant" },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.userId).toBe(userId);
      expect(JSON.stringify(rows[0]?.metadata)).toContain(ANTHROPIC);
      // The credential value never reaches the log.
      expect(JSON.stringify(rows[0]?.metadata)).not.toContain("enc:");
    } finally {
      await db.auditLog.deleteMany({ where: { workspaceId: WORKSPACE } });
      await db.user.deleteMany({ where: { id: userId } });
    }
  });

  it("an ORG-scoped key created later widens nothing — planted control", async () => {
    // An org key is reachable by EVERY workspace in the org, so auto-granting
    // it would quietly widen every workspace at once. `createSecret` is called
    // with an org scope and no workspace, and the attach must not run at all.
    await makeAgent(AGENT);

    const secret = await secretService.createSecret(
      { organizationId: ORG },
      {
        name: "Org Anthropic Key",
        type: "anthropic",
        value: "sk-ant-org",
        hostPattern: "api.anthropic.com",
      },
    );

    expect(secret.attachedAgents).toEqual([]);
    expect(await attached(AGENT)).toEqual([]);
    expect(await resolved(AGENT)).toBeNull();
    await db.secret.deleteMany({ where: { id: secret.id } });
  });

  it("an agent in ANOTHER workspace is never touched by a key here", async () => {
    // The second half of the fence: the keyless sweep is bounded by the
    // workspace, so a sibling workspace's keyless agent stays keyless.
    const foreignAgent = `${P}foreign-agent`;
    await makeSecret(ANTHROPIC, "anthropic");
    await makeAgent(AGENT);
    await makeAgent(foreignAgent, OTHER_WORKSPACE);

    const { agentIds } = await autoAttach.attachLlmKeyToKeylessAgents(
      WORKSPACE,
      ANTHROPIC,
      null,
    );

    expect(agentIds).toEqual([AGENT]);
  });
});
