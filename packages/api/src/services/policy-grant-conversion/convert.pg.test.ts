import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { proofDatabaseUrl } from "../../testing/pg-proof.js";

/**
 * The step-5 converter on REAL PostgreSQL — every law proven through the same
 * read paths production uses. The matrix (per the approved plan): the
 * from-nothing publish (95% of prod), fold parity via the real evaluator
 * before vs after, selective normalization (equipment AND custom injection
 * vehicles, session policies round-tripped through the jsonb publish), the
 * deletion set with the planted blocklist survivor, block-default reset,
 * idempotence, concurrency, the all-or-nothing per-project abort, the planted
 * cross-org negative control (the step-10 lesson), the planted partner-scoped
 * secret staying OUT of grants (the gateway serves that tier), level-scope
 * expansion, user-pinned folds via the real principal set, and the
 * verify-failure path that never flips.
 *
 * Env-gated like the other proof suites; see load-rules.pg.test.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Convert = typeof import("./convert");
type Loaders = typeof import("../policy-simulate/load-rules");
type SimRule = typeof import("../policy-simulate/sim-rule");
type Hosts = typeof import("../policy-simulate/secret-hosts");
type Providers = typeof import("../policy-simulate/connection-providers");
type Evaluator = typeof import("../policy-translation/evaluator");

let db: Db;
let convert: Convert;
let loaders: Loaders;
let simRule: SimRule;
let secretHosts: Hosts;
let connectionProviders: Providers;
let evaluator: Evaluator;

const P = "gcv-";
const GMAIL_HOST = "gmail.googleapis.com";

let seq = 0;

interface World {
  org: string;
  project: string;
}

const newWorld = async (): Promise<World> => {
  const n = `${P}${String(seq++)}`;
  const org = `${n}-org`;
  const project = `${n}-proj`;
  await db.organization.create({ data: { id: org, name: org, slug: org } });
  await db.project.create({
    data: { id: project, name: project, organizationId: org },
  });
  return { org, project };
};

const addAgent = async (
  w: World,
  id: string,
  secretMode: "all" | "selective",
) => {
  const full = `${w.project}-${id}`;
  await db.agent.create({
    data: {
      id: full,
      projectId: w.project,
      name: id,
      identifier: full,
      accessToken: `aoc_${full}`,
      secretMode,
    },
  });
  return full;
};

const addConnection = async (
  w: World,
  id: string,
  over: Record<string, unknown> = {},
) => {
  const full = `${w.project}-${id}`;
  await db.appConnection.create({
    data: {
      id: full,
      provider: "gmail",
      scope: "project",
      status: "connected",
      projectId: w.project,
      organizationId: w.org,
      label: id,
      ...over,
    },
  });
  return full;
};

const addSecret = async (
  w: World,
  id: string,
  over: Record<string, unknown> = {},
) => {
  const full = `${w.project}-${id}`;
  await db.secret.create({
    data: {
      id: full,
      name: id,
      type: "generic",
      hostPattern: "api.gcv.example",
      scope: "project",
      projectId: w.project,
      organizationId: w.org,
      ...over,
    },
  });
  return full;
};

interface RuleSpec {
  name: string;
  action: "allow" | "block";
  scope?: "project" | "organization";
  source?: string;
  isDefault?: boolean;
  requireApproval?: boolean;
  rateLimit?: number;
  rateLimitWindow?: string;
  conditions?: unknown;
  priority?: number;
  agentIds?: string[];
  userIds?: string[];
  targets?: {
    kind: "app" | "connection" | "secret" | "network";
    appProvider?: string;
    appTools?: string[];
    appConnectionScope?: string;
    appConnectionId?: string;
    secretId?: string;
    secretScope?: string;
    hostPattern?: string;
  }[];
}

/** Seed one rule as BOTH the draft (gen 0) and a published gen-1 snapshot —
 * the shape every real converted project has. */
const addRule = async (w: World, spec: RuleSpec) => {
  const logicalId = `${w.project}-lg-${String(seq++)}`;
  for (const [status, generation] of [
    ["draft", 0],
    ["published", 1],
  ] as const) {
    await db.policyRuleV2.create({
      data: {
        scope: spec.scope ?? "project",
        projectId: (spec.scope ?? "project") === "project" ? w.project : null,
        organizationId: (spec.scope ?? "project") === "project" ? null : w.org,
        status,
        generation,
        priority: spec.priority ?? seq,
        enabled: true,
        isDefault: spec.isDefault ?? false,
        logicalId,
        source: spec.source ?? (spec.isDefault ? "default" : "custom"),
        name: spec.name,
        action: spec.action,
        requireApproval: spec.requireApproval ?? false,
        rateLimit: spec.rateLimit ?? null,
        rateLimitWindow: spec.rateLimitWindow ?? null,
        conditions:
          spec.conditions === undefined
            ? undefined
            : (spec.conditions as object),
        identities: {
          create: [
            ...(spec.agentIds ?? []).map((agentId) => ({
              agent: { connect: { id: agentId } },
            })),
            ...(spec.userIds ?? []).map((userId) => ({
              user: { connect: { id: userId } },
            })),
          ],
        },
        targets: {
          create: (spec.targets ?? []).map((t) => ({
            kind: t.kind,
            appProvider: t.appProvider ?? null,
            appTools: t.appTools ?? [],
            appConnectionScope: t.appConnectionScope ?? null,
            hostPattern: t.hostPattern ?? null,
            ...(t.appConnectionId
              ? { appConnection: { connect: { id: t.appConnectionId } } }
              : {}),
            ...(t.secretId ? { secret: { connect: { id: t.secretId } } } : {}),
          })),
        },
      },
    });
  }
};

/** A ProjectAccess-reachable ACTIVE member, so user-pinned rules bind. */
const addProjectUser = async (w: World, id: string) => {
  const full = `${w.project}-${id}`;
  await db.user.create({
    data: {
      id: full,
      email: `${full}@gcv.invalid`,
      externalAuthId: full,
    },
  });
  await db.organizationMember.create({
    data: {
      organizationId: w.org,
      userId: full,
      userEmail: `${full}@gcv.invalid`,
      role: "member",
    },
  });
  await db.projectAccess.create({
    data: { id: `${full}-pa`, projectId: w.project, userId: full },
  });
  return full;
};

const reset = async () => {
  await db.policyRuleV2.deleteMany({
    where: {
      OR: [
        { projectId: { startsWith: P } },
        { organizationId: { startsWith: P } },
      ],
    },
  });
  await db.projectAccess.deleteMany({ where: { id: { startsWith: P } } });
  await db.organizationMember.deleteMany({
    where: { organizationId: { startsWith: P } },
  });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
  await db.appConnection.deleteMany({ where: { id: { startsWith: P } } });
  await db.secret.deleteMany({
    where: {
      OR: [{ id: { startsWith: P } }, { partnerId: { startsWith: P } }],
    },
  });
  await db.agent.deleteMany({ where: { id: { startsWith: P } } });
  await db.project.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
  await db.partner.deleteMany({ where: { id: { startsWith: P } } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  convert = await import("./convert");
  loaders = await import("../policy-simulate/load-rules");
  simRule = await import("../policy-simulate/sim-rule");
  secretHosts = await import("../policy-simulate/secret-hosts");
  connectionProviders = await import("../policy-simulate/connection-providers");
  evaluator = await import("../policy-translation/evaluator");
  await reset();
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.$disconnect();
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await reset();
});

/** Decide a request against the project's published MAX generation — exactly
 * the rows the gateway assembles. */
const decide = async (
  w: World,
  opts: {
    path: string;
    method: string;
    agentId: string;
    winner?: string;
    host?: string;
  },
) => {
  const base = { scope: "project" as const, projectId: w.project };
  const [rows, hosts, providers] = await Promise.all([
    loaders.loadRulesForSimulation(base, "published"),
    secretHosts.loadSecretHosts(w.org, w.project),
    connectionProviders.loadConnectionProviders(w.org, w.project),
  ]);
  const rules = rows.map((r) => simRule.toSimRule(r, hosts, providers).rule);
  return evaluator.evaluateNew(rules, {
    host: opts.host ?? GMAIL_HOST,
    path: opts.path,
    method: opts.method,
    agentId: opts.agentId,
    hasInjections: true,
    isLlmHost: false,
    winningConnectionId: opts.winner,
  });
};

const draftRows = (w: World, extra: Record<string, unknown> = {}) =>
  db.policyRuleV2.findMany({
    where: { projectId: w.project, status: "draft", ...extra },
    include: { identities: true, targets: true },
    orderBy: [{ priority: "asc" }, { id: "asc" }],
  });

const agentMode = async (id: string) =>
  (
    await db.agent.findUniqueOrThrow({
      where: { id },
      select: { secretMode: true },
    })
  ).secretMode;

const convertOne = async (w: World) => {
  const result = convert.emptyGrantConversionResult();
  await convert.convertProject(
    { id: w.project, organizationId: w.org },
    result,
  );
  return result;
};

describe.skipIf(!PROOF_URL)("grant conversion over real PostgreSQL", () => {
  it("(a+l) from-nothing: the pool becomes stacks, the default publishes allow, the agent flips — and a partner secret stays out", async () => {
    const w = await newWorld();
    const agent = await addAgent(w, "a1", "all");
    const conn = await addConnection(w, "work");
    const orgConn = await addConnection(w, "shared", {
      scope: "organization",
      projectId: null,
    });
    const projSecret = await addSecret(w, "sk");
    const orgSecret = await addSecret(w, "ok", {
      scope: "organization",
      projectId: null,
    });
    // The planted partner tier: reachable by all-mode injection at the
    // GATEWAY, but grants must never reference it (no vocabulary — the
    // mode-independent gateway tier serves it).
    await db.partner.create({
      data: {
        id: `${P}partner`,
        name: `${P}partner`,
        slug: `${w.project}-partner`,
        apiKey: `oc_partner_${w.project}`,
      },
    });
    await db.organization.update({
      where: { id: w.org },
      data: { partnerId: `${P}partner` },
    });
    await db.secret.create({
      data: {
        id: `${w.project}-partner-secret`,
        name: "partner llm key",
        type: "anthropic",
        hostPattern: "api.anthropic.com",
        scope: "partner",
        partnerId: `${P}partner`,
      },
    });

    const result = await convertOne(w);

    expect(result.projectsConverted).toBe(1);
    expect(result.agentsFlipped).toBe(1);
    expect(await agentMode(agent)).toBe("selective");

    // Stacks: one whole-app allow per pooled connection, one allow per pooled
    // org/project secret — and NOTHING referencing the partner secret.
    const rows = await draftRows(w, { source: "grant" });
    const connTargets = rows
      .filter((r) => r.targets[0]?.kind === "connection")
      .map((r) => r.targets[0]?.appConnectionId)
      .sort();
    expect(connTargets).toEqual([conn, orgConn].sort());
    const secretTargets = rows
      .filter((r) => r.targets[0]?.kind === "secret")
      .map((r) => r.targets[0]?.secretId)
      .sort();
    expect(secretTargets).toEqual([projSecret, orgSecret].sort());
    expect(rows.every((r) => r.identities[0]?.agentId === agent)).toBe(true);
    expect(
      rows.every(
        (r) => r.targets[0]?.secretId !== `${w.project}-partner-secret`,
      ),
    ).toBe(true);

    // Published truth: generation 1 exists, its default is allow, and a
    // catalog request decides allow via the winner (not merely by default).
    const published = await db.policyRuleV2.findMany({
      where: { projectId: w.project, status: "published", generation: 1 },
    });
    expect(published.length).toBeGreaterThan(0);
    expect(published.some((r) => r.isDefault && r.action === "allow")).toBe(
      true,
    );
    const verdict = await decide(w, {
      path: "/gmail/v1/users/me/drafts",
      method: "POST",
      agentId: agent,
      winner: conn,
    });
    expect(verdict.action).toBe("allow");
  });

  it("(b+o+s) folding preserves per-tool verdicts — approval, agent-pinned and USER-pinned blocks — and counts dropped rate limits", async () => {
    const w = await newWorld();
    const agentA = await addAgent(w, "a", "all");
    const agentB = await addAgent(w, "b", "all");
    const conn = await addConnection(w, "work");
    const user = await addProjectUser(w, "u1");
    await addRule(w, {
      name: "ask before batch delete",
      action: "allow",
      requireApproval: true,
      targets: [
        {
          kind: "app",
          appProvider: "gmail",
          appTools: ["batch_delete_messages"],
        },
      ],
    });
    await addRule(w, {
      name: "A may not draft",
      action: "block",
      agentIds: [agentA],
      targets: [
        { kind: "app", appProvider: "gmail", appTools: ["create_draft"] },
      ],
    });
    // The adversarial-review case: a USER-pinned rule reaches agent traffic
    // through the ProjectAccess principal set — an empty-principals fold
    // would turn this block into allow.
    await addRule(w, {
      name: "u1 may not search",
      action: "block",
      userIds: [user],
      targets: [
        { kind: "app", appProvider: "gmail", appTools: ["search_messages"] },
      ],
    });
    await addRule(w, {
      name: "rate-limited reads",
      action: "allow",
      rateLimit: 5,
      rateLimitWindow: "minute",
      targets: [
        { kind: "app", appProvider: "gmail", appTools: ["get_message"] },
      ],
    });

    const before = {
      draftA: await decide(w, {
        path: "/gmail/v1/users/me/drafts",
        method: "POST",
        agentId: agentA,
        winner: conn,
      }),
      batchA: await decide(w, {
        path: "/gmail/v1/users/me/messages/batchDelete",
        method: "POST",
        agentId: agentA,
        winner: conn,
      }),
    };
    expect(before.draftA.action).toBe("block");
    expect(before.batchA).toMatchObject({
      action: "allow",
      requireApproval: true,
    });

    const result = await convertOne(w);
    expect(result.projectsConverted).toBe(1);
    expect(result.rateLimitsDropped).toBe(1);
    expect(result.rulesDeleted.custom).toBe(4);

    // Customs gone; only grants + default remain.
    const remaining = await draftRows(w, { isDefault: false });
    expect(remaining.every((r) => r.source === "grant")).toBe(true);

    // Parity, via the real evaluator on the published max generation.
    const draftA = await decide(w, {
      path: "/gmail/v1/users/me/drafts",
      method: "POST",
      agentId: agentA,
      winner: conn,
    });
    expect(draftA.action).toBe("block");
    const draftB = await decide(w, {
      path: "/gmail/v1/users/me/drafts",
      method: "POST",
      agentId: agentB,
      winner: conn,
    });
    expect(draftB.action).toBe("allow");
    const batchA = await decide(w, {
      path: "/gmail/v1/users/me/messages/batchDelete",
      method: "POST",
      agentId: agentA,
      winner: conn,
    });
    expect(batchA).toMatchObject({ action: "allow", requireApproval: true });
    // The user-pinned block folded into BOTH agents' stacks (the principal
    // set applies to every agent of the project).
    const searchA = await decide(w, {
      path: "/gmail/v1/users/me/messages",
      method: "GET",
      agentId: agentA,
      winner: conn,
    });
    expect(searchA.action).toBe("block");
  });

  it("(c+q) selective normalization: equipment rows become grants, the session policy rides EVERY allow row through the jsonb publish, org rules untouched", async () => {
    const w = await newWorld();
    const agent = await addAgent(w, "sel", "selective");
    const conn = await addConnection(w, "dropbox", { provider: "dropbox" });
    const secret = await addSecret(w, "eqsk");
    const POLICY = { folders: ["/Reports"] };
    await addRule(w, {
      name: "equipment: dropbox",
      action: "allow",
      source: "equipment",
      conditions: POLICY,
      agentIds: [agent],
      targets: [{ kind: "connection", appConnectionId: conn }],
    });
    await addRule(w, {
      name: "equipment: secret",
      action: "allow",
      source: "equipment",
      agentIds: [agent],
      targets: [{ kind: "secret", secretId: secret }],
    });
    await addRule(w, {
      name: "org guardrail",
      action: "block",
      scope: "organization",
      targets: [{ kind: "network", hostPattern: "blocked.example" }],
    });

    const result = await convertOne(w);
    expect(result.rulesDeleted.equipment).toBe(2);
    expect(result.sessionPoliciesCarried).toBe(1);
    // Already selective — never (re)flipped.
    expect(result.agentsFlipped).toBe(0);
    expect(await agentMode(agent)).toBe("selective");

    // Equipment gone; the grants carry the policy on every allow-action row,
    // draft AND published (the jsonb round-trip the gateway will read).
    expect(await draftRows(w, { source: "equipment" })).toHaveLength(0);
    for (const status of ["draft", "published"] as const) {
      const rows = await db.policyRuleV2.findMany({
        where: {
          projectId: w.project,
          status,
          source: "grant",
          ...(status === "published" ? {} : {}),
        },
        include: { targets: true },
        orderBy: [{ generation: "desc" }, { priority: "asc" }],
      });
      const connAllows = rows.filter(
        (r) =>
          r.action === "allow" &&
          r.targets.some((t) => t.appConnectionId === conn),
      );
      expect(connAllows.length).toBeGreaterThan(0);
      for (const row of connAllows) {
        expect(JSON.parse(JSON.stringify(row.conditions))).toEqual(POLICY);
      }
    }

    // The org guardrail is byte-untouched.
    const orgRules = await db.policyRuleV2.findMany({
      where: { organizationId: w.org, scope: "organization" },
    });
    expect(orgRules).toHaveLength(2); // draft + published seed
  });

  it("(d) a locked-out selective agent (no rules) is left completely alone", async () => {
    const w = await newWorld();
    const agent = await addAgent(w, "locked", "selective");
    await addConnection(w, "work");

    const result = await convertOne(w);

    // Nothing to do for this project at all — the fast path skips it.
    expect(result.projectsSkipped).toBe(1);
    expect(await draftRows(w)).toHaveLength(0);
    expect(await agentMode(agent)).toBe("selective");
  });

  it("(e) the deletion set goes; a planted blocklist row SURVIVES in draft and published", async () => {
    const w = await newWorld();
    await addAgent(w, "a1", "all");
    await addConnection(w, "work");
    await addRule(w, {
      name: "network custom",
      action: "block",
      targets: [{ kind: "network", hostPattern: "evil.example" }],
    });
    await addRule(w, {
      name: "behavioral",
      action: "block",
      conditions: [{ target: "body", operator: "contains", value: "x" }],
      targets: [{ kind: "app", appProvider: "gmail", appTools: [] }],
    });
    await addRule(w, {
      name: "blocklist: gmail admin",
      action: "block",
      source: "blocklist",
      targets: [{ kind: "network", hostPattern: "admin.googleapis.com" }],
    });

    const result = await convertOne(w);
    expect(result.rulesDeleted.network).toBe(1);
    expect(result.rulesDeleted.behavioral).toBe(1);

    const survivors = await draftRows(w, { source: "blocklist" });
    expect(survivors).toHaveLength(1);
    const publishedMax = await db.policyRuleV2.aggregate({
      where: { projectId: w.project, status: "published" },
      _max: { generation: true },
    });
    const publishedBlocklist = await db.policyRuleV2.findMany({
      where: {
        projectId: w.project,
        status: "published",
        generation: publishedMax._max.generation ?? 0,
        source: "blocklist",
      },
    });
    expect(publishedBlocklist).toHaveLength(1);
  });

  it("(f+r) a Block default resets to allow; its catalog meaning survives as stack blocks (an all-blocked connection keeps NO allow row)", async () => {
    const w = await newWorld();
    const agent = await addAgent(w, "a1", "all");
    const conn = await addConnection(w, "work");
    await addRule(w, {
      name: "Default Rule",
      action: "block",
      isDefault: true,
      source: "default",
      priority: 0,
    });

    // Pre-conversion: block-by-default (with injections on a non-LLM host).
    const before = await decide(w, {
      path: "/gmail/v1/users/me/drafts",
      method: "POST",
      agentId: agent,
      winner: conn,
    });
    expect(before.action).toBe("block");

    const result = await convertOne(w);
    expect(result.defaultsReset).toBe(1);

    // The default is allow now — but the connection's stack blocks every
    // catalog tool (the fold saw block-by-default per tool), so the verdict
    // is unchanged and there is NO allow row → the gateway never selects the
    // connection (fail-closed, the recorded shape change).
    const defaultRow = (await draftRows(w, { isDefault: true }))[0];
    expect(defaultRow?.action).toBe("allow");
    const after = await decide(w, {
      path: "/gmail/v1/users/me/drafts",
      method: "POST",
      agentId: agent,
      winner: conn,
    });
    expect(after.action).toBe("block");
    const grantRows = await draftRows(w, { source: "grant" });
    const connRows = grantRows.filter((r) =>
      r.targets.some((t) => t.appConnectionId === conn),
    );
    expect(connRows.length).toBeGreaterThan(0);
    expect(connRows.every((r) => r.action === "block")).toBe(true);
  });

  it("(g) idempotence: the second run is a fast-path no-op with byte-identical rules", async () => {
    const w = await newWorld();
    await addAgent(w, "a1", "all");
    await addConnection(w, "work");
    await addSecret(w, "sk");

    const first = await convertOne(w);
    expect(first.projectsConverted).toBe(1);
    const rowsAfterFirst = await draftRows(w);

    const second = await convertOne(w);
    expect(second.projectsConverted).toBe(0);
    expect(second.projectsSkipped).toBe(1);
    const rowsAfterSecond = await draftRows(w);
    expect(rowsAfterSecond.map((r) => r.id)).toEqual(
      rowsAfterFirst.map((r) => r.id),
    );
    expect(JSON.parse(JSON.stringify(rowsAfterSecond))).toEqual(
      JSON.parse(JSON.stringify(rowsAfterFirst)),
    );
  });

  it("(h) two racing conversions serialize on the advisory lock and converge", async () => {
    const w = await newWorld();
    const agent = await addAgent(w, "a1", "all");
    await addConnection(w, "work");

    const [r1, r2] = await Promise.all([convertOne(w), convertOne(w)]);

    // Exactly one run converts; the other either skipped (saw the flip under
    // the lock) or was preempted at verify. Never both, never neither.
    const converted = r1.projectsConverted + r2.projectsConverted;
    const skippedOrPreempted =
      r1.projectsSkipped + r2.projectsSkipped + r1.preempted + r2.preempted;
    expect(converted).toBeGreaterThanOrEqual(1);
    expect(converted + skippedOrPreempted).toBe(2);
    expect(await agentMode(agent)).toBe("selective");
    // One coherent stack — the delete-then-recompile never doubles rows.
    const rows = await draftRows(w, { source: "grant" });
    expect(rows).toHaveLength(1);
  });

  it("(i) a per-agent compile failure aborts the WHOLE project — no partial deletion, no flip", async () => {
    const w = await newWorld();
    const agentA = await addAgent(w, "a", "all");
    const agentB = await addAgent(w, "b", "all");
    await addConnection(w, "work");
    await addRule(w, {
      name: "shared guardrail",
      action: "block",
      targets: [
        { kind: "app", appProvider: "gmail", appTools: ["create_draft"] },
      ],
    });

    vi.resetModules();
    vi.doMock("../policy-reflect/effective-tools", async (importOriginal) => {
      const real =
        await importOriginal<
          typeof import("../policy-reflect/effective-tools")
        >();
      return {
        ...real,
        computeEffectiveGroups: (input: { agentId: string }) => {
          if (input.agentId === agentB) throw new Error("poisoned fold");
          return real.computeEffectiveGroups(
            input as Parameters<typeof real.computeEffectiveGroups>[0],
          );
        },
      };
    });
    const faulted = await import("./convert");
    const result = faulted.emptyGrantConversionResult();
    await expect(
      faulted.convertProject({ id: w.project, organizationId: w.org }, result),
    ).rejects.toThrow("poisoned fold");
    vi.doUnmock("../policy-reflect/effective-tools");
    vi.resetModules();
    convert = await import("./convert");

    // All-or-nothing: the shared guardrail survives, nothing was published,
    // and BOTH agents are still all-mode (agent A included).
    expect(await agentMode(agentA)).toBe("all");
    expect(await agentMode(agentB)).toBe("all");
    expect(await draftRows(w, { source: "custom" })).toHaveLength(1);
    expect(await draftRows(w, { source: "grant" })).toHaveLength(0);
    const published = await db.policyRuleV2.findMany({
      where: {
        projectId: w.project,
        status: "published",
        generation: { gt: 1 },
      },
    });
    expect(published).toHaveLength(0);

    // The clean converter heals it fully on the next pass.
    const healed = await convertOne(w);
    expect(healed.projectsConverted).toBe(1);
    expect(await agentMode(agentB)).toBe("selective");
  });

  it("(j) the planted cross-org control: converting org A leaves org B byte-untouched", async () => {
    const wA = await newWorld();
    const wB = await newWorld();
    await addAgent(wA, "a1", "all");
    await addConnection(wA, "work");
    const agentB = await addAgent(wB, "b1", "all");
    await addConnection(wB, "other");
    await addRule(wB, {
      name: "B custom",
      action: "block",
      targets: [
        { kind: "app", appProvider: "gmail", appTools: ["create_draft"] },
      ],
    });
    const bBefore = JSON.parse(
      JSON.stringify(await draftRows(wB, {})),
    ) as unknown;

    const result = await convertOne(wA);
    expect(result.projectsConverted).toBe(1);

    expect(JSON.parse(JSON.stringify(await draftRows(wB, {})))).toEqual(
      bBefore,
    );
    expect(await agentMode(agentB)).toBe("all");
  });

  it("(k) a verification failure keeps the generation and never flips", async () => {
    const w = await newWorld();
    const agent = await addAgent(w, "a1", "all");
    await addConnection(w, "work");

    vi.resetModules();
    vi.doMock("../grants-compile", async (importOriginal) => {
      const real = await importOriginal<typeof import("../grants-compile")>();
      return { ...real, stackEquals: () => false };
    });
    const faulted = await import("./convert");
    const result = faulted.emptyGrantConversionResult();
    await faulted.convertProject(
      { id: w.project, organizationId: w.org },
      result,
    );
    vi.doUnmock("../grants-compile");
    vi.resetModules();
    convert = await import("./convert");

    expect(result.verifyFailed).toBe(1);
    expect(result.agentsFlipped).toBe(0);
    expect(await agentMode(agent)).toBe("all");
    // The generation is KEPT — it is what is enforcing.
    const published = await db.policyRuleV2.findMany({
      where: { projectId: w.project, status: "published" },
    });
    expect(published.length).toBeGreaterThan(0);

    // The FIXPOINT property: the customs are already consumed, but the fold
    // reads the written grant stacks themselves, so a clean re-run reproduces
    // the same stacks (delete-then-recompile), verifies, and flips — the
    // verify-failed interim self-heals instead of drifting looser.
    const healed = await convertOne(w);
    expect(healed.projectsConverted).toBe(1);
    expect(healed.agentsFlipped).toBe(1);
    expect(await agentMode(agent)).toBe("selective");
    const grantRows = await draftRows(w, { source: "grant" });
    expect(grantRows).toHaveLength(1);
    expect(grantRows[0]?.action).toBe("allow");
  });

  it("(m+n+p) selective custom vehicles normalize: a level-scope app rule expands per connection, a secret-target rule becomes a secret grant", async () => {
    const w = await newWorld();
    const agent = await addAgent(w, "sel", "selective");
    const orgConn1 = await addConnection(w, "org1", {
      scope: "organization",
      projectId: null,
    });
    const orgConn2 = await addConnection(w, "org2", {
      scope: "organization",
      projectId: null,
    });
    await addConnection(w, "proj-conn"); // project scope — NOT in the org-level expansion
    const secret = await addSecret(w, "sk");
    await addRule(w, {
      name: "all org gmail",
      action: "allow",
      agentIds: [agent],
      targets: [
        {
          kind: "app",
          appProvider: "gmail",
          appConnectionScope: "organization",
        },
      ],
    });
    await addRule(w, {
      name: "the secret",
      action: "allow",
      agentIds: [agent],
      targets: [{ kind: "secret", secretId: secret }],
    });

    const result = await convertOne(w);
    expect(result.projectsConverted).toBe(1);

    const rows = await draftRows(w, { source: "grant" });
    const connTargets = new Set(
      rows.flatMap((r) =>
        r.targets.flatMap((t) =>
          t.appConnectionId ? [t.appConnectionId] : [],
        ),
      ),
    );
    expect(connTargets).toEqual(new Set([orgConn1, orgConn2]));
    expect(rows.some((r) => r.targets.some((t) => t.secretId === secret))).toBe(
      true,
    );
    // The custom vehicles are gone — their meaning lives in the grants.
    expect(await draftRows(w, { source: "custom" })).toHaveLength(0);
  });
});
