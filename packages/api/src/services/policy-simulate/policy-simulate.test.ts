import { beforeEach, describe, expect, it, vi } from "vitest";

// The simulate services' contracts: every read is org/project-FENCED at the
// query level (cross-org isolation), the rule load mirrors the GATEWAY's load
// (enabled-only, defaults included, equipment dropped, max published
// generation), the row→rule mapper decodes all four identity kinds + resolves
// secret hosts AND connection providers fail-closed, and the injection probe
// distinguishes selective/all agents. The db is mocked at the boundary; wheres
// are recorded and asserted — the SQL behavior itself is review-verified
// against real PG.

const state = vi.hoisted(() => ({
  calls: [] as { model: string; op: string; args: unknown }[],
  results: new Map<string, unknown>(),
  /** Args-aware responders for models read more than once CONCURRENTLY —
   * call order is not deterministic, so results key off the where clause. */
  responders: new Map<string, (args: unknown) => unknown>(),
  aggregate: { _max: { generation: null as number | null } },
}));

const record = vi.hoisted(
  () =>
    (model: string) =>
    (op: string) =>
    async (args: unknown): Promise<unknown> => {
      state.calls.push({ model, op, args });
      if (op === "aggregate") return state.aggregate;
      const key = `${model}.${op}`;
      const responder = state.responders.get(key);
      if (responder) return responder(args);
      return state.results.get(key) ?? (op === "findFirst" ? null : []);
    },
);

vi.mock("@onecli/db", () => {
  const model = (name: string) => ({
    findMany: record(name)("findMany"),
    findFirst: record(name)("findFirst"),
    aggregate: record(name)("aggregate"),
  });
  return {
    Prisma: {},
    db: {
      agent: model("agent"),
      agentGroupMember: model("agentGroupMember"),
      projectAccess: model("projectAccess"),
      group: model("group"),
      groupMember: model("groupMember"),
      organizationMember: model("organizationMember"),
      secret: model("secret"),
      appConnection: model("appConnection"),
      policyRuleV2: model("policyRuleV2"),
    },
  };
});

const { resolvePrincipalSet } = await import("./principal-set");
const { loadSecretHosts } = await import("./secret-hosts");
const { loadConnectionProviders } = await import("./connection-providers");
const { loadRulesForSimulation } = await import("./load-rules");
const { toSimRule } = await import("./sim-rule");
const { deriveHasInjections } = await import("./injection-probe");
const { simulatePolicy } = await import("./simulate");
import type { SimRuleRow } from "./load-rules";

const whereOf = (model: string, index = 0): Record<string, unknown> => {
  const call = state.calls.filter((c) => c.model === model)[index];
  return (call?.args as { where: Record<string, unknown> })?.where ?? {};
};

beforeEach(() => {
  state.calls = [];
  state.results = new Map();
  state.responders = new Map();
  state.aggregate = { _max: { generation: null } };
});

describe("resolvePrincipalSet (find_principal_set mirror)", () => {
  it("org-fences every arm and filters suspended members", async () => {
    state.results.set("agentGroupMember.findMany", [{ agentGroupId: "ag1" }]);
    state.results.set("projectAccess.findMany", [
      { userId: "u1", groupId: null },
      { userId: null, groupId: "g1" },
    ]);
    state.results.set("group.findMany", [{ id: "g1" }]);
    // groupMember is read twice (group→members, then user→groups) — the shared
    // stub row carries both fields so each read maps its own column.
    state.results.set("groupMember.findMany", [
      { userId: "u2", groupId: "g1" },
    ]);
    state.results.set("organizationMember.findMany", [{ userId: "u1" }]);

    const set = await resolvePrincipalSet("agent-1", "p1", "org-1");

    // The agent-group arm is fenced via the group's org.
    expect(whereOf("agentGroupMember")).toEqual({
      agentId: "agent-1",
      agentGroup: { organizationId: "org-1" },
    });
    // Granted groups are org-fenced.
    expect(whereOf("group")).toEqual({
      id: { in: ["g1"] },
      organizationId: "org-1",
    });
    // Only ACTIVE members of THIS org survive (u2 was filtered out).
    expect(whereOf("organizationMember")).toEqual({
      userId: { in: ["u1", "u2"] },
      organizationId: "org-1",
      status: { not: "suspended" },
    });
    expect(set.agentGroupIds).toEqual(["ag1"]);
    expect(set.userIds).toEqual(["u1"]);
    expect(set.groupIds).toEqual(["g1"]);
  });

  it("expands the surviving users' groups org-fenced", async () => {
    state.results.set("projectAccess.findMany", [
      { userId: "u1", groupId: null },
    ]);
    state.results.set("organizationMember.findMany", [{ userId: "u1" }]);
    state.results.set("groupMember.findMany", [{ groupId: "g9" }]);

    const set = await resolvePrincipalSet("a", "p1", "org-1");

    // The user→groups expansion carries the org fence (a user can belong to
    // OTHER orgs' groups).
    const expansion = state.calls.filter((c) => c.model === "groupMember");
    expect(
      (expansion.at(-1)?.args as { where: Record<string, unknown> }).where,
    ).toEqual({ userId: { in: ["u1"] }, group: { organizationId: "org-1" } });
    expect(set.groupIds).toEqual(["g9"]);
  });
});

describe("loadSecretHosts (find_secret_hosts mirror)", () => {
  it("fences to the acting org+project and splits levels", async () => {
    state.results.set("secret.findMany", [
      { id: "s1", hostPattern: "api.a.com", scope: "project" },
      { id: "s2", hostPattern: "api.b.com", scope: "organization" },
    ]);

    const set = await loadSecretHosts("org-1", "p1");

    expect(whereOf("secret")).toEqual({
      OR: [
        { projectId: "p1" },
        { organizationId: "org-1", scope: "organization" },
      ],
    });
    expect(set.projectHosts).toEqual(["api.a.com"]);
    expect(set.orgHosts).toEqual(["api.b.com"]);
    expect(set.byId.get("s2")).toBe("api.b.com");
  });
});

describe("loadConnectionProviders (find_connection_providers mirror)", () => {
  it("fences to the acting org+project — a foreign connection id can never resolve", async () => {
    state.results.set("appConnection.findMany", [
      { id: "c1", provider: "gmail" },
      { id: "c2", provider: "github" },
    ]);

    const map = await loadConnectionProviders("org-1", "p1");

    // The fence IS the query — identical shape to the secret-hosts fence, so a
    // rule naming another org's connection id resolves to nothing (fail-closed).
    expect(whereOf("appConnection")).toEqual({
      OR: [
        { projectId: "p1" },
        { organizationId: "org-1", scope: "organization" },
      ],
    });
    expect(map.get("c1")).toBe("gmail");
    expect(map.get("c-foreign")).toBeUndefined();
  });
});

describe("loadRulesForSimulation (gateway-load mirror)", () => {
  it("loads enabled non-equipment rules, defaults INCLUDED", async () => {
    await loadRulesForSimulation(
      { scope: "project", projectId: "p1" },
      "draft",
    );

    const where = whereOf("policyRuleV2");
    expect(where).toEqual({
      scope: "project",
      projectId: "p1",
      status: "draft",
      enabled: true,
      source: { not: "equipment" },
    });
    // No isDefault filter — the Default Rules must load.
    expect("isDefault" in where).toBe(false);
  });

  it("pins published to the active max generation", async () => {
    state.aggregate = { _max: { generation: 4 } };
    await loadRulesForSimulation(
      { scope: "organization", organizationId: "org-1" },
      "published",
    );

    const find = state.calls.find(
      (c) => c.model === "policyRuleV2" && c.op === "findMany",
    );
    expect(
      (find?.args as { where: { generation: number } }).where.generation,
    ).toBe(4);
  });

  it("returns [] when nothing was ever published", async () => {
    expect(
      await loadRulesForSimulation(
        { scope: "organization", organizationId: "org-1" },
        "published",
      ),
    ).toEqual([]);
  });

  // The TS engine's `NewRule` carries no id, so its evaluator can't re-sort by
  // id — the equal-priority tie-break lives ENTIRELY in this loader's orderBy
  // (a stable priority-only sort downstream preserves it). Pin it so a regression
  // can't silently desync the simulator/reflections from the gateway, which
  // enforces `ORDER BY r.priority, r.id`.
  it("orders by (priority, id) — the gateway-consistent tie-break", async () => {
    await loadRulesForSimulation(
      { scope: "project", projectId: "p1" },
      "draft",
    );
    const find = state.calls.find(
      (c) => c.model === "policyRuleV2" && c.op === "findMany",
    );
    expect((find?.args as { orderBy: unknown }).orderBy).toEqual([
      { priority: "asc" },
      { id: "asc" },
    ]);
  });
});

// ── toSimRule (pure) ────────────────────────────────────────────────────────

const simRow = (over: Partial<SimRuleRow>): SimRuleRow =>
  ({
    id: "r1",
    scope: "project",
    projectId: "p1",
    organizationId: null,
    status: "published",
    generation: 1,
    priority: 1,
    enabled: true,
    isDefault: false,
    logicalId: "l1",
    source: "custom",
    name: "Rule",
    description: null,
    action: "block",
    rateLimit: null,
    rateLimitWindow: null,
    requireApproval: false,
    conditions: null,
    createdByUserId: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    identities: [],
    targets: [],
    ...over,
  }) as SimRuleRow;

const identityRow = (
  over: Partial<SimRuleRow["identities"][number]>,
): SimRuleRow["identities"][number] =>
  ({
    id: "i1",
    ruleId: "r1",
    agentId: null,
    agentGroupId: null,
    userId: null,
    groupId: null,
    ...over,
  }) as SimRuleRow["identities"][number];

const targetRow = (
  over: { kind: string } & Partial<SimRuleRow["targets"][number]>,
): SimRuleRow["targets"][number] =>
  ({
    id: "t1",
    ruleId: "r1",
    appProvider: null,
    appTools: [],
    appConnectionScope: null,
    appConnectionId: null,
    secretId: null,
    secretScope: null,
    hostPattern: null,
    pathPattern: null,
    method: null,
    ...over,
  }) as SimRuleRow["targets"][number];

const emptyHosts = {
  byId: new Map<string, string>(),
  projectHosts: [],
  orgHosts: [],
};

const emptyProviders = new Map<string, string>();

describe("toSimRule (decode_row mirror, full fidelity)", () => {
  it("decodes all FOUR identity kinds", () => {
    const { rule } = toSimRule(
      simRow({
        identities: [
          identityRow({ agentId: "a1" }),
          identityRow({ agentGroupId: "ag1" }),
          identityRow({ userId: "u1" }),
          identityRow({ groupId: "g1" }),
        ],
      }),
      emptyHosts,
      emptyProviders,
    );
    expect(rule.identities).toEqual([
      { type: "agent", id: "a1" },
      { type: "agentGroup", id: "ag1" },
      { type: "user", id: "u1" },
      { type: "group", id: "g1" },
    ]);
  });

  it("resolves a specific secret target to its fenced host, fail-closed", () => {
    const hosts = {
      byId: new Map([["s1", "api.a.com"]]),
      projectHosts: ["api.a.com"],
      orgHosts: ["api.o.com"],
    };
    const { rule } = toSimRule(
      simRow({
        targets: [
          targetRow({ kind: "secret", secretId: "s1" }),
          targetRow({ kind: "secret", secretId: "missing" }),
          targetRow({ kind: "secret", secretScope: "organization" }),
        ],
      }),
      hosts,
      emptyProviders,
    );
    expect(rule.targets).toEqual([
      { kind: "secret", hostPatterns: ["api.a.com"] },
      { kind: "secret", hostPatterns: [] },
      { kind: "secret", hostPatterns: ["api.o.com"] },
    ]);
  });

  it("maps unknown/provider-less targets to inert connection targets", () => {
    const { rule } = toSimRule(
      simRow({
        targets: [targetRow({ kind: "app" }), targetRow({ kind: "mystery" })],
      }),
      emptyHosts,
      emptyProviders,
    );
    expect(rule.targets.every((t) => t.kind === "connection")).toBe(true);
  });

  it("resolves a connection target to its provider as a whole-app target", () => {
    // Mirror of the gateway's assemble.rs connection arm: the fenced map turns
    // the connection into a whole-app target (no tools → the provider's catalog
    // hosts, host-only).
    const { rule } = toSimRule(
      simRow({
        targets: [targetRow({ kind: "connection", appConnectionId: "c1" })],
      }),
      emptyHosts,
      new Map([["c1", "gmail"]]),
    );
    expect(rule.targets).toEqual([
      { kind: "app", provider: "gmail", tools: [], connectionScope: null },
    ]);
  });

  it("carries a tool-narrowed connection target's tools onto the resolved app target", () => {
    // The "Specific connection(s)" tools-picker shape: a connection target with
    // tools resolves to an app target that keeps them (→ the tool fan-out, not
    // the whole app) — the gateway's assemble.rs connection arm mirror.
    const { rule } = toSimRule(
      simRow({
        targets: [
          targetRow({
            kind: "connection",
            appConnectionId: "c1",
            appTools: ["read_message", "search_messages"],
          }),
        ],
      }),
      emptyHosts,
      new Map([["c1", "gmail"]]),
    );
    expect(rule.targets).toEqual([
      {
        kind: "app",
        provider: "gmail",
        tools: ["read_message", "search_messages"],
        connectionScope: null,
      },
    ]);
  });

  it("leaves a connection target inert when its id is missing from the fenced map", () => {
    // Deleted in the cache window, or foreign/forged (the fence excluded it) —
    // the target stays an unresolved connection target (never matches).
    const { rule } = toSimRule(
      simRow({
        targets: [targetRow({ kind: "connection", appConnectionId: "c-gone" })],
      }),
      emptyHosts,
      emptyProviders,
    );
    expect(rule.targets).toEqual([
      { kind: "connection", connectionId: "c-gone", tools: [] },
    ]);
  });

  it("keeps a degenerate identity row as a never-matching entry (gateway mirror)", () => {
    // A no-principal row is impossible per the DB CHECK, but the mirror must
    // not INVERT it: dropping the entry would flip `identities: []` = "any
    // agent" (the gateway keeps `Identity::Unresolved` — never matches).
    const { rule } = toSimRule(
      simRow({ identities: [identityRow({})] }),
      emptyHosts,
      emptyProviders,
    );
    expect(rule.identities).toEqual([{ type: "agent", id: "" }]);
  });

  it("coerces malformed conditions to null, all-or-nothing", () => {
    const good = toSimRule(
      simRow({
        conditions: [{ target: "body", operator: "contains", value: "x" }],
      }),
      emptyHosts,
      emptyProviders,
    );
    const bad = toSimRule(
      simRow({
        conditions: [
          { target: "body", operator: "contains", value: "x" },
          { broken: true },
        ],
      }),
      emptyHosts,
      emptyProviders,
    );
    expect(good.rule.conditions).toEqual([
      { target: "body", operator: "contains", value: "x" },
    ]);
    expect(bad.rule.conditions).toBeNull();
  });

  it("carries the naming metadata beside the engine rule", () => {
    const sim = toSimRule(
      simRow({
        id: "row-9",
        logicalId: "l-9",
        name: "Named",
        scope: "organization",
      }),
      emptyHosts,
      emptyProviders,
    );
    expect(sim.meta).toEqual({
      id: "row-9",
      logicalId: "l-9",
      name: "Named",
      scope: "organization",
      source: "custom",
    });
  });
});

describe("deriveHasInjections (injection probe)", () => {
  // The probe now answers from the same law the reflections use. The old copy
  // read the legacy per-agent grant tables, which the gateway stopped reading at
  // step 10 — so a credential granted the normal way (a policy rule) came back
  // as "no injections", the deny-default carve was disarmed, and the simulator
  // reported Allow for requests the gateway BLOCKS.

  /** Distinguish the two readers of each model — they run concurrently, so call
   * order is not stable. The pool reads select only the value; the resolver
   * reads also select `id`. */
  const wirePool = (opts: {
    poolSecretHosts?: string[];
    poolProviders?: string[];
    secretHostsById?: { id: string; hostPattern: string; scope: string }[];
    connectionProviders?: { id: string; provider: string }[];
    rules?: SimRuleRow[];
  }) => {
    state.responders.set("secret.findMany", (args) => {
      const select = (args as { select: Record<string, unknown> }).select;
      return select.id
        ? (opts.secretHostsById ?? [])
        : (opts.poolSecretHosts ?? []).map((hostPattern) => ({ hostPattern }));
    });
    state.responders.set("appConnection.findMany", (args) => {
      const select = (args as { select: Record<string, unknown> }).select;
      return select.id
        ? (opts.connectionProviders ?? [])
        : (opts.poolProviders ?? []).map((provider) => ({ provider }));
    });
    // Honour the `source: { not: … }` filter the loader applies, so a test can
    // actually tell the injection load (equipment KEPT) from the decision load
    // (equipment dropped) — otherwise it passes either way.
    state.responders.set("policyRuleV2.findMany", (args) => {
      const where = (args as { where: { source?: { not?: string } } }).where;
      const excluded = where.source?.not;
      return (opts.rules ?? []).filter(
        (r) => excluded === undefined || r.source !== excluded,
      );
    });
    state.aggregate = { _max: { generation: 1 } };
  };

  const noPrincipals = { agentGroupIds: [], userIds: [], groupIds: [] };

  it("a selective agent with NO rule grant injects nothing", async () => {
    // Fail-closed, and the fenced pool must NOT be consulted for it — that is
    // what `secret_mode` being the switch means in the gateway.
    wirePool({ poolSecretHosts: ["api.a.com"] });

    const hit = await deriveHasInjections(
      { id: "agent-1", secretMode: "selective", projectId: "p1" },
      "org-1",
      "api.a.com",
      noPrincipals,
    );
    expect(hit).toBe(false);
  });

  it("a selective agent's RULE GRANT injects — including an equipment rule", async () => {
    // THE regression: this grant has no row in the legacy tables, so the old
    // probe missed it. Equipment-sourced, because that is what the frozen
    // per-agent grants became — the injection load keeps them, the decision
    // load drops them.
    wirePool({
      secretHostsById: [
        { id: "s1", hostPattern: "api.a.com", scope: "project" },
      ],
      rules: [
        simRow({
          source: "equipment",
          action: "allow",
          identities: [identityRow({ agentId: "agent-1" })],
          targets: [targetRow({ kind: "secret", secretId: "s1" })],
        }),
      ],
    });

    const hit = await deriveHasInjections(
      { id: "agent-1", secretMode: "selective", projectId: "p1" },
      "org-1",
      "api.a.com",
      noPrincipals,
    );
    expect(hit).toBe(true);
  });

  it("a grant naming ANOTHER agent does not inject here", async () => {
    wirePool({
      secretHostsById: [
        { id: "s1", hostPattern: "api.a.com", scope: "project" },
      ],
      rules: [
        simRow({
          source: "equipment",
          action: "allow",
          identities: [identityRow({ agentId: "someone-else" })],
          targets: [targetRow({ kind: "secret", secretId: "s1" })],
        }),
      ],
    });

    const hit = await deriveHasInjections(
      { id: "agent-1", secretMode: "selective", projectId: "p1" },
      "org-1",
      "api.a.com",
      noPrincipals,
    );
    expect(hit).toBe(false);
  });

  it("all-mode agents draw from the fenced project+org credential pool", async () => {
    wirePool({ poolSecretHosts: ["api.a.com"] });

    const hit = await deriveHasInjections(
      { id: "agent-1", secretMode: "all", projectId: "p1" },
      "org-1",
      "api.a.com",
      noPrincipals,
    );
    expect(hit).toBe(true);

    // The pool read is org+project fenced — no cross-org leak.
    const poolWhere = state.calls
      .filter((c) => c.model === "secret" && c.op === "findMany")
      .map((c) => (c.args as { where: unknown }).where);
    expect(poolWhere).toContainEqual({
      OR: [
        { projectId: "p1" },
        { organizationId: "org-1", scope: "organization" },
      ],
    });
  });

  it("matches connections via the provider's catalog tool hosts", async () => {
    wirePool({ poolProviders: ["github"] });
    await expect(
      deriveHasInjections(
        { id: "a", secretMode: "all", projectId: "p1" },
        "org-1",
        "api.github.com",
        noPrincipals,
      ),
    ).resolves.toBe(true);

    wirePool({ poolProviders: ["github"] });
    await expect(
      deriveHasInjections(
        { id: "a", secretMode: "all", projectId: "p1" },
        "org-1",
        "api.unrelated.com",
        noPrincipals,
      ),
    ).resolves.toBe(false);
  });
});

// ── simulatePolicy end-to-end (service layer) ───────────────────────────────

const BAIT = "SECRET-ORG-RULE-NAME-BAIT";

const orgBlockRow = () =>
  simRow({
    id: "org-r1",
    logicalId: "org-l1",
    scope: "organization",
    organizationId: "org-1",
    projectId: null,
    name: BAIT,
    action: "block",
    targets: [targetRow({ kind: "network", hostPattern: "api.x.com" })],
  });

const simulateCtx = (viewerSeesOrgRules: boolean) => ({
  projectId: "p1",
  organizationId: "org-1",
  viewerSeesOrgRules,
});

const baseSimInput = {
  agentId: "agent-1",
  host: "api.x.com",
  method: "POST",
  hasInjectionsOverride: true,
};

const armSimulateStubs = (orgRows: SimRuleRow[], projectRows: SimRuleRow[]) => {
  state.results.set("agent.findFirst", {
    id: "agent-1",
    secretMode: "all",
    projectId: "p1",
  });
  state.aggregate = { _max: { generation: 1 } };
  // The org + project loads run CONCURRENTLY — answer by scope, not order.
  state.responders.set("policyRuleV2.findMany", (args) =>
    (args as { where: { scope: string } }).where.scope === "organization"
      ? orgRows
      : projectRows,
  );
};

describe("simulatePolicy (redaction + fences)", () => {
  it("REDACTS an org-rule decision for non-admins — the bait never leaks", async () => {
    armSimulateStubs([orgBlockRow()], []);

    const result = await simulatePolicy(baseSimInput, simulateCtx(false));

    expect(result.decision).toEqual({ action: "block" });
    expect(result.decidedBy).toEqual({
      kind: "rule",
      scope: "organization",
      redacted: true,
    });
    // The load-bearing assertion: NOTHING in the serialized response carries
    // the org rule's name (or ids).
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(BAIT);
    expect(serialized).not.toContain("org-l1");
  });

  it("shows the full org rule to org admins", async () => {
    armSimulateStubs([orgBlockRow()], []);

    const result = await simulatePolicy(baseSimInput, simulateCtx(true));

    expect(result.decidedBy).toMatchObject({
      kind: "rule",
      scope: "organization",
      rule: { name: BAIT, logicalId: "org-l1", action: "block" },
    });
  });

  it("shows project rules unredacted to everyone", async () => {
    armSimulateStubs(
      [],
      [
        simRow({
          id: "p-r1",
          logicalId: "p-l1",
          name: "Project block",
          action: "block",
          targets: [targetRow({ kind: "network", hostPattern: "api.x.com" })],
        }),
      ],
    );

    const result = await simulatePolicy(baseSimInput, simulateCtx(false));

    expect(result.decidedBy).toMatchObject({
      kind: "rule",
      scope: "project",
      rule: { name: "Project block" },
    });
  });

  it("404s an agent outside the caller's project (fence)", async () => {
    state.results.set("agent.findFirst", null);
    await expect(
      simulatePolicy(
        { ...baseSimInput, agentId: "foreign-agent" },
        simulateCtx(true),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The fence is the QUERY: id + the caller's project.
    expect(whereOf("agent")).toEqual({
      id: "foreign-agent",
      projectId: "p1",
    });
  });

  it("attributes a deny-default block to its level without leaking the default row", async () => {
    armSimulateStubs(
      [
        simRow({
          id: "org-d",
          logicalId: "org-dl",
          scope: "organization",
          organizationId: "org-1",
          projectId: null,
          name: BAIT,
          action: "block",
          isDefault: true,
          source: "default",
          targets: [],
        }),
      ],
      [],
    );

    const result = await simulatePolicy(
      { ...baseSimInput, host: "unmatched.example.com" },
      simulateCtx(false),
    );

    expect(result.decision).toEqual({ action: "block", byDefault: true });
    expect(result.decidedBy).toEqual({
      kind: "default",
      scope: "organization",
      action: "block",
    });
    expect(JSON.stringify(result)).not.toContain(BAIT);
  });

  it("scopes the body-condition count to the viewer's visibility", async () => {
    const orgBodyRule = simRow({
      id: "org-bc",
      logicalId: "org-bc-l",
      scope: "organization",
      organizationId: "org-1",
      projectId: null,
      name: BAIT,
      action: "block",
      conditions: [{ target: "body", operator: "contains", value: "secret" }],
      targets: [targetRow({ kind: "network", hostPattern: "api.x.com" })],
    });
    armSimulateStubs([orgBodyRule], []);
    const member = await simulatePolicy(
      { ...baseSimInput, host: "other.example.com" },
      simulateCtx(false),
    );
    // The org rule's body-condition count is ORG information — redacted
    // viewers must not learn it.
    expect(member.bodyConditionsSkipped).toBe(0);

    armSimulateStubs([orgBodyRule], []);
    const admin = await simulatePolicy(
      { ...baseSimInput, host: "other.example.com" },
      simulateCtx(true),
    );
    expect(admin.bodyConditionsSkipped).toBe(1);
  });

  it("reads the project DRAFT when includeStaged is set (org stays published)", async () => {
    armSimulateStubs([], []);

    await simulatePolicy(
      { ...baseSimInput, includeStaged: true },
      simulateCtx(true),
    );

    const wheres = state.calls
      .filter((c) => c.model === "policyRuleV2" && c.op === "findMany")
      .map((c) => (c.args as { where: Record<string, unknown> }).where);
    // Concurrent loads — select by scope, not call order.
    expect(wheres.find((w) => w.scope === "organization")).toMatchObject({
      status: "published",
    });
    expect(wheres.find((w) => w.scope === "project")).toMatchObject({
      status: "draft",
    });
  });

  it("strips the port and echoes the derived inputs", async () => {
    armSimulateStubs([], []);

    const result = await simulatePolicy(
      { ...baseSimInput, host: "API.X.com:8443", hasInjectionsOverride: false },
      simulateCtx(true),
    );

    expect(result.inputs.host).toBe("api.x.com");
    expect(result.inputs.hasInjections).toBe(false);
    expect(result.inputs.hasInjectionsBasis).toBe("override");
    expect(result.decidedBy).toEqual({ kind: "none", managed: false });
  });
});

// ── Whole-app + connection targets through the full service (step-8 symmetry) ─

describe("simulatePolicy — whole-app and connection targets", () => {
  const projectDefaultBlock = () =>
    simRow({
      id: "p-default",
      logicalId: "p-default-l",
      name: "Default Rule",
      action: "block",
      isDefault: true,
      source: "default",
      priority: 100,
      targets: [],
    });
  const orgDefaultAllow = () =>
    simRow({
      id: "org-default",
      logicalId: "org-default-l",
      scope: "organization",
      organizationId: "org-1",
      projectId: null,
      name: "Default Rule",
      action: "allow",
      isDefault: true,
      source: "default",
      priority: 100,
      targets: [],
    });

  it("the user-reported repro: 'Allow gmail · all connections' beats a staged default Block", async () => {
    // The exact reported shape: a project draft with an allow · gmail · all
    // connections rule above a staged Default Rule Block (allowlist mode); a
    // credential-managed request to gmail's catalog host must now be ALLOWED and
    // attributed to that rule — the allow includes the app's traffic.
    armSimulateStubs(
      [orgDefaultAllow()],
      [
        simRow({
          id: "p-gmail",
          logicalId: "p-gmail-l",
          name: "Allow gmail all connections",
          action: "allow",
          targets: [
            targetRow({
              kind: "app",
              appProvider: "gmail",
              appConnectionScope: "project",
            }),
          ],
        }),
        projectDefaultBlock(),
      ],
    );

    const result = await simulatePolicy(
      {
        agentId: "agent-1",
        host: "gmail.googleapis.com",
        method: "GET",
        includeStaged: true,
        hasInjectionsOverride: true,
      },
      simulateCtx(false),
    );

    expect(result.decision).toEqual({ action: "allow" });
    expect(result.decidedBy).toMatchObject({
      kind: "rule",
      scope: "project",
      rule: { name: "Allow gmail all connections", logicalId: "p-gmail-l" },
    });
  });

  it("the whole-app allow permits only the provider's hosts — others still hit the default", async () => {
    armSimulateStubs(
      [orgDefaultAllow()],
      [
        simRow({
          id: "p-gmail",
          logicalId: "p-gmail-l",
          name: "Allow gmail all connections",
          action: "allow",
          targets: [
            targetRow({
              kind: "app",
              appProvider: "gmail",
              appConnectionScope: "project",
            }),
          ],
        }),
        projectDefaultBlock(),
      ],
    );

    const result = await simulatePolicy(
      {
        agentId: "agent-1",
        host: "api.github.com",
        method: "GET",
        hasInjectionsOverride: true,
      },
      simulateCtx(false),
    );

    expect(result.decision).toEqual({ action: "block", byDefault: true });
    expect(result.decidedBy).toEqual({
      kind: "default",
      scope: "project",
      action: "block",
    });
  });

  it("a specific-connection rule permits its provider's hosts via the fenced map", async () => {
    state.results.set("appConnection.findMany", [
      { id: "c-gmail", provider: "gmail" },
    ]);
    armSimulateStubs(
      [orgDefaultAllow()],
      [
        simRow({
          id: "p-conn",
          logicalId: "p-conn-l",
          name: "Allow the gmail connection",
          action: "allow",
          targets: [
            targetRow({ kind: "connection", appConnectionId: "c-gmail" }),
          ],
        }),
        projectDefaultBlock(),
      ],
    );

    const result = await simulatePolicy(
      {
        agentId: "agent-1",
        host: "gmail.googleapis.com",
        method: "GET",
        hasInjectionsOverride: true,
      },
      simulateCtx(false),
    );

    expect(result.decision).toEqual({ action: "allow" });
    expect(result.decidedBy).toMatchObject({
      kind: "rule",
      rule: { name: "Allow the gmail connection" },
    });
    // The provider map read is fenced to the acting org+project — the planted
    // cross-org shape: a foreign org's connection id would simply not be in
    // this result set (asserted below).
    expect(whereOf("appConnection")).toEqual({
      OR: [
        { projectId: "p1" },
        { organizationId: "org-1", scope: "organization" },
      ],
    });
  });

  it("a TOOL-NARROWED specific-connection rule matches only that tool's endpoint (the user's repro)", async () => {
    // App › GitHub › Specific connection, narrowed to create_issue (POST
    // api.github.com /repos/*/*/issues). The named endpoint is allowed; a
    // different endpoint of the same connection falls to the project default.
    const armGithubConnRule = () => {
      state.results.set("appConnection.findMany", [
        { id: "c-gh", provider: "github" },
      ]);
      armSimulateStubs(
        [orgDefaultAllow()],
        [
          simRow({
            id: "p-conn-t",
            logicalId: "p-conn-t-l",
            name: "Allow the github connection · create issue",
            action: "allow",
            targets: [
              targetRow({
                kind: "connection",
                appConnectionId: "c-gh",
                appTools: ["create_issue"],
              }),
            ],
          }),
          projectDefaultBlock(),
        ],
      );
    };

    armGithubConnRule();
    const hit = await simulatePolicy(
      {
        agentId: "agent-1",
        host: "api.github.com",
        path: "/repos/o/r/issues",
        method: "POST",
        hasInjectionsOverride: true,
      },
      simulateCtx(false),
    );
    expect(hit.decision).toEqual({ action: "allow" });
    expect(hit.decidedBy).toMatchObject({
      kind: "rule",
      rule: { name: "Allow the github connection · create issue" },
    });

    state.calls = [];
    armGithubConnRule();
    const miss = await simulatePolicy(
      {
        agentId: "agent-1",
        host: "api.github.com",
        path: "/repos/o/r/issues",
        method: "GET", // not create_issue (POST) → not matched by the tool
        hasInjectionsOverride: true,
      },
      simulateCtx(false),
    );
    expect(miss.decision).toEqual({ action: "block", byDefault: true });
    expect(miss.decidedBy).toEqual({
      kind: "default",
      scope: "project",
      action: "block",
    });
  });

  it("bodyConditionsSkipped counts only rules whose conditions actually gate", async () => {
    // A whole-app rule's conditions are IGNORED live too — nothing was
    // "skipped" for it; a network rule's body condition genuinely can't be
    // evaluated here and counts.
    const bodyCond = [{ target: "body", operator: "contains", value: "x" }];
    armSimulateStubs(
      [orgDefaultAllow()],
      [
        simRow({
          id: "p-whole",
          logicalId: "p-whole-l",
          name: "Whole app with conditions",
          action: "allow",
          conditions: bodyCond,
          targets: [
            targetRow({
              kind: "app",
              appProvider: "gmail",
              appConnectionScope: "project",
            }),
          ],
        }),
        simRow({
          id: "p-net",
          logicalId: "p-net-l",
          name: "Network with conditions",
          action: "allow",
          conditions: bodyCond,
          targets: [targetRow({ kind: "network", hostPattern: "api.x.com" })],
        }),
      ],
    );

    const result = await simulatePolicy(
      {
        agentId: "agent-1",
        host: "unmatched.example.com",
        method: "GET",
        hasInjectionsOverride: false,
      },
      simulateCtx(true),
    );

    expect(result.bodyConditionsSkipped).toBe(1);
  });

  it("a deleted (or cross-org) connection id fails closed to the default", async () => {
    // The fenced load returns nothing for the id — deleted, or org B's
    // connection planted in an org A rule — so the target never matches.
    state.results.set("appConnection.findMany", []);
    armSimulateStubs(
      [orgDefaultAllow()],
      [
        simRow({
          id: "p-conn",
          logicalId: "p-conn-l",
          name: "Allow the gmail connection",
          action: "allow",
          targets: [
            targetRow({ kind: "connection", appConnectionId: "c-foreign" }),
          ],
        }),
        projectDefaultBlock(),
      ],
    );

    const result = await simulatePolicy(
      {
        agentId: "agent-1",
        host: "gmail.googleapis.com",
        method: "GET",
        hasInjectionsOverride: true,
      },
      simulateCtx(false),
    );

    expect(result.decision).toEqual({ action: "block", byDefault: true });
    expect(result.decidedBy).toEqual({
      kind: "default",
      scope: "project",
      action: "block",
    });
  });
});
