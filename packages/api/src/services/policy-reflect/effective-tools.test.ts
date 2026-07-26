import { beforeEach, describe, expect, it, vi } from "vitest";

// The effective-app-permissions reflection's contracts (step 9.7b): the
// AGREEMENT LAW (per-tool verdicts ≡ an independent per-variant composition of
// the real evaluator on the same seeded rules), org/project fencing at the
// query level, the simulate redaction contract (org rule names never reach a
// non-admin response — planted bait), the DERIVED injection basis (an
// unconnected app leaves the deny-default unenforced), baseline honesty
// (variesByIdentity, viewer-scoped), and the no-endpoint-leak constraint. The
// db is mocked at the boundary; wheres are recorded and asserted.

const state = vi.hoisted(() => ({
  calls: [] as { model: string; op: string; args: unknown }[],
  results: new Map<string, unknown>(),
  /** Args-aware responders for models read more than once CONCURRENTLY. */
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

const { effectiveAppPermissions } = await import("./effective-tools");
const { buildInjectionProbe } = await import("./injection");
const { toSimRule } = await import("../policy-simulate/sim-rule");
const { evaluatePolicyOutcome } =
  await import("../policy-translation/evaluator");
const { allRuleVariants } =
  await import("../policy-translation/translate/app-catalog");
const { getAppPermissionDefinition } =
  await import("../../apps/app-permissions");
const { isLlmHost } = await import("../../lib/path-match");
import type { SimRuleRow } from "../policy-simulate/load-rules";
import type { PolicyOutcome } from "../policy-translation/types";

const whereOf = (model: string, index = 0): Record<string, unknown> => {
  const call = state.calls.filter((c) => c.model === model)[index];
  return (call?.args as { where: Record<string, unknown> })?.where ?? {};
};

beforeEach(() => {
  state.calls = [];
  state.results = new Map();
  state.responders = new Map();
  state.aggregate = { _max: { generation: 1 } };
});

// ── row builders (the policy-simulate.test shapes) ──────────────────────────

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
  projectHosts: [] as string[],
  orgHosts: [] as string[],
};
const emptyProviders = new Map<string, string>();

// ── stub arming ──────────────────────────────────────────────────────────────

const AGENT = { id: "agent-1", secretMode: "all", projectId: "p1" };

/** Arm the concurrent reads: rules by scope; the two secret reads told apart by
 * their select shape (loadSecretHosts selects id/scope, the probe doesn't); the
 * two appConnection reads by the probe's status filter. */
const armStubs = (opts: {
  orgRows?: SimRuleRow[];
  projectRows?: SimRuleRow[];
  agent?: { id: string; secretMode: string } | null;
  probeConnections?: { provider: string }[];
  providerRows?: { id: string; provider: string }[];
}) => {
  // `undefined` = the default agent; an explicit `null` = not found (fence).
  state.results.set(
    "agent.findFirst",
    opts.agent !== undefined ? opts.agent : AGENT,
  );
  state.responders.set("policyRuleV2.findMany", (args) => {
    const where = (args as { where: { scope: string } }).where;
    return where.scope === "organization"
      ? (opts.orgRows ?? [])
      : (opts.projectRows ?? []);
  });
  state.responders.set("secret.findMany", (args) => {
    const select = (args as { select: Record<string, boolean> }).select;
    if (select.id) return []; // loadSecretHosts
    return []; // the injection probe's secrets
  });
  state.responders.set("appConnection.findMany", (args) => {
    const where = (args as { where: { status?: string } }).where;
    if (where.status === "connected") return opts.probeConnections ?? [];
    return opts.providerRows ?? []; // loadConnectionProviders
  });
};

// ── the independent expected-composition (the agreement law's other side) ────

/** In-test substitution, deliberately NOT the service's helper: replace every
 * `*` with the same token, per segment. */
const subst = (pattern: string): string =>
  pattern === "*" ? "/oc-any" : pattern.replaceAll("*", "oc-any");

type Verdict = "allow" | "approval" | "block" | "mixed" | "unmanaged";

const expectedVerdicts = (
  provider: string,
  rows: SimRuleRow[],
  opts: { hasInjections: boolean },
): Map<string, Verdict> => {
  const rules = rows.map((r) => toSimRule(r, emptyHosts, emptyProviders).rule);
  const def = getAppPermissionDefinition(provider);
  if (!def) throw new Error("no catalog");
  const out = new Map<string, Verdict>();
  for (const group of def.groups) {
    for (const tool of group.tools) {
      const host = subst(tool.hostPattern);
      const verdicts = new Set<string>();
      for (const variant of allRuleVariants(tool)) {
        const outcome: PolicyOutcome = evaluatePolicyOutcome(rules, {
          host,
          path: subst(variant.pathPattern),
          method: variant.method ?? "GET",
          agentId: "agent-1",
          agentGroupIds: [],
          userIds: [],
          groupIds: [],
          hasInjections: opts.hasInjections,
          isLlmHost: isLlmHost(host),
        });
        if (outcome.kind === "rule") {
          verdicts.add(
            outcome.rule.action === "block"
              ? "block"
              : outcome.rule.requireApproval
                ? "approval"
                : `allow|${outcome.rule.rateLimit ?? ""}`,
          );
        } else if (outcome.kind === "denyDefault") {
          verdicts.add("block");
        } else {
          verdicts.add(outcome.managed ? "allow|" : "unmanaged");
        }
      }
      const [single] = [...verdicts];
      out.set(
        tool.id,
        verdicts.size !== 1 || single === undefined
          ? "mixed"
          : ((single.startsWith("allow") ? "allow" : single) as Verdict),
      );
    }
  }
  return out;
};

const PROJECT_CTX = {
  scope: "project" as const,
  projectId: "p1",
  organizationId: "org-1",
  viewerSeesOrgRules: true,
};

// ─────────────────────────────────────────────────────────────────────────────

describe("the agreement law (per-tool verdicts ≡ the evaluator)", () => {
  it("matches an independent per-variant composition across ALL gmail tools", async () => {
    const orgAllow = simRow({
      id: "o1",
      scope: "organization",
      projectId: null,
      organizationId: "org-1",
      logicalId: "org-allow",
      name: "Org gmail rate",
      action: "allow",
      rateLimit: 100,
      rateLimitWindow: "minute",
      priority: 1,
      targets: [targetRow({ kind: "app", appProvider: "gmail" })],
    });
    const projectBlock = simRow({
      id: "p-block",
      logicalId: "block-deletes",
      name: "Block gmail deletes",
      action: "block",
      priority: 1,
      targets: [
        targetRow({
          kind: "app",
          appProvider: "gmail",
          appTools: ["delete_message", "delete_thread"],
        }),
      ],
    });
    armStubs({
      orgRows: [orgAllow],
      projectRows: [projectBlock],
      probeConnections: [{ provider: "gmail" }],
    });

    const result = await effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1" },
      PROJECT_CTX,
    );

    const expected = expectedVerdicts("gmail", [orgAllow, projectBlock], {
      hasInjections: true, // the connected-gmail probe attaches every gmail host
    });
    const actual = new Map(
      result.groups.flatMap((g) => g.tools.map((t) => [t.toolId, t.verdict])),
    );
    expect(actual).toEqual(expected);
    // Spot-pin the shape the law is made of: deletes blocked, reads allowed
    // with the org rate disclosed.
    expect(actual.get("delete_message")).toBe("block");
    const read = result.groups
      .find((g) => g.category === "read")!
      .tools.find((t) => t.toolId === "search_messages")!;
    expect(read.verdict).toBe("allow");
    expect(read.rateLimit).toBe(100);
    expect(result.basis.credentialAttached).toBe(true);
  });

  it("mixed: a method-scoped network block splits a multi-method tool", async () => {
    // jira `search_issues` is GET+POST; block only the POST face.
    const postBlock = simRow({
      logicalId: "block-jql-post",
      name: "Block JQL POST",
      action: "block",
      targets: [
        targetRow({
          kind: "network",
          hostPattern: "api.atlassian.com",
          pathPattern: "/ex/jira/*/rest/api/3/search/jql",
          method: "POST",
        }),
      ],
    });
    armStubs({ projectRows: [postBlock] });

    const result = await effectiveAppPermissions(
      { provider: "jira", agentId: "agent-1" },
      PROJECT_CTX,
    );

    const expected = expectedVerdicts("jira", [postBlock], {
      hasInjections: false,
    });
    const readGroup = result.groups.find((g) => g.category === "read")!;
    const search = readGroup.tools.find((t) => t.toolId === "search_issues")!;
    expect(expected.get("search_issues")).toBe("mixed");
    expect(search.verdict).toBe("mixed");
    expect(search.decidedBy).toBeNull();
    // The group rollup surfaces the disagreement too.
    expect(readGroup.verdict).toBe("mixed");
  });
});

describe("derived injection basis", () => {
  it("an unconnected app leaves the deny-default unenforced (unmanaged)", async () => {
    const projectDefault = simRow({
      id: "d1",
      logicalId: "default",
      name: "Default",
      isDefault: true,
      source: "default",
      action: "block",
      priority: 10_000,
    });
    armStubs({ projectRows: [projectDefault] });

    const result = await effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1" },
      PROJECT_CTX,
    );

    expect(result.basis.credentialAttached).toBe(false);
    for (const group of result.groups) {
      for (const tool of group.tools) {
        expect(tool.verdict).toBe("unmanaged");
        expect(tool.decidedBy).toBeNull();
      }
    }
  });

  it("a connected app enforces the deny-default (block, attributed)", async () => {
    const projectDefault = simRow({
      id: "d1",
      logicalId: "default",
      name: "Default",
      isDefault: true,
      source: "default",
      action: "block",
      priority: 10_000,
    });
    armStubs({
      projectRows: [projectDefault],
      probeConnections: [{ provider: "gmail" }],
    });

    const result = await effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1" },
      PROJECT_CTX,
    );

    expect(result.basis.credentialAttached).toBe(true);
    for (const group of result.groups) {
      for (const tool of group.tools) {
        expect(tool.verdict).toBe("block");
        expect(tool.decidedBy).toEqual({ kind: "default", scope: "project" });
      }
    }
  });

  it("F1: a selective agent's RULE-GRANTED connection makes its tools managed, not unmanaged", async () => {
    // Selective agent, ZERO assigned credentials, a project allow rule granting
    // connection c1 (gmail) narrowed to reads, + project Default Block. The
    // grant must fold into the injection probe (inject_select.rs) so the WRITE
    // tools — which the read-only grant doesn't permit — are deny-default
    // BLOCKED, not "unmanaged". Pre-fix (assigned-only probe) they'd read
    // unmanaged while the credential dialog said "via rule" — the contradiction.
    const grant = simRow({
      id: "grant",
      logicalId: "gmail-reads",
      name: "Gmail reads via c1",
      action: "allow",
      identities: [identityRow({ agentId: "agent-1" })],
      targets: [
        targetRow({
          kind: "connection",
          appConnectionId: "c1",
          appTools: ["read_all"],
        }),
      ],
    });
    const projectDefault = simRow({
      id: "d1",
      logicalId: "default",
      name: "Default",
      isDefault: true,
      source: "default",
      action: "block",
      priority: 10_000,
    });
    armStubs({
      agent: { id: "agent-1", secretMode: "selective" },
      projectRows: [grant, projectDefault],
      // c1 resolves to gmail via loadConnectionProviders; it is NOT in the
      // assigned pool (probeConnections empty) — only the RULE grants it.
      providerRows: [{ id: "c1", provider: "gmail" }],
    });

    const result = await effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1" },
      PROJECT_CTX,
    );

    // The grant folded in → gmail is managed for this agent.
    expect(result.basis.credentialAttached).toBe(true);
    const write = result.groups.find((g) => g.category === "write")!;
    for (const tool of write.tools) {
      expect(tool.verdict).toBe("block"); // deny-default BITES (not unmanaged)
    }
  });
});

describe("buildInjectionProbe (the inject_select mirror)", () => {
  const SECRET_HOSTS = {
    byId: new Map([["s1", "api.secretco.com"]]),
    projectHosts: ["api.secretco.com"],
    orgHosts: [] as string[],
  };
  const CONN_PROVIDERS = new Map([["c1", "gmail"]]);
  const PRINCIPALS = { agentGroupIds: [], userIds: [], groupIds: [] };

  const probeFor = (
    agent: { id: string; secretMode: string } | null,
    rules: SimRuleRow[],
    pool: { poolSecretHostPatterns?: string[]; poolProviders?: string[] } = {},
  ) =>
    buildInjectionProbe({
      agent,
      poolSecretHostPatterns: pool.poolSecretHostPatterns ?? [],
      poolProviders: pool.poolProviders ?? [],
      rules,
      principals: PRINCIPALS,
      secretHosts: SECRET_HOSTS,
      connectionProviders: CONN_PROVIDERS,
    });

  const connGrant = (over: Partial<SimRuleRow> = {}) =>
    simRow({
      action: "allow",
      identities: [identityRow({ agentId: "agent-1" })],
      targets: [targetRow({ kind: "connection", appConnectionId: "c1" })],
      ...over,
    });

  it("folds a selective agent's rule-granted connection", () => {
    const probe = probeFor({ id: "agent-1", secretMode: "selective" }, [
      connGrant(),
    ]);
    expect(probe("gmail.googleapis.com")).toBe(true);
    expect(probe("api.unrelated.com")).toBe(false);
  });

  it("folds a secretScope pool grant to the level's hosts", () => {
    const probe = probeFor({ id: "agent-1", secretMode: "selective" }, [
      connGrant({
        targets: [targetRow({ kind: "secret", secretScope: "project" })],
      }),
    ]);
    expect(probe("api.secretco.com")).toBe(true);
  });

  it("PLANTED BAIT: an empty-identity rule is NEVER folded (injection is explicit-only)", () => {
    const probe = probeFor({ id: "agent-1", secretMode: "selective" }, [
      connGrant({ identities: [] }),
    ]);
    expect(probe("gmail.googleapis.com")).toBe(false);
  });

  it("skips block rules and app targets WITHOUT connectionScope", () => {
    const probe = probeFor({ id: "agent-1", secretMode: "selective" }, [
      connGrant({ action: "block" }),
      simRow({
        id: "r2",
        action: "allow",
        identities: [identityRow({ id: "i2", agentId: "agent-1" })],
        targets: [targetRow({ id: "t2", kind: "app", appProvider: "gmail" })],
      }),
    ]);
    expect(probe("gmail.googleapis.com")).toBe(false);
  });

  it("an all-mode agent ignores grants — the pool is authoritative", () => {
    // The grant would fold gmail in for a selective agent; for all-mode the
    // pool is the whole truth, so an empty pool stays empty.
    const probe = probeFor({ id: "agent-1", secretMode: "all" }, [connGrant()]);
    expect(probe("gmail.googleapis.com")).toBe(false);
  });
});

describe("F2: agreeing variants never read as `mixed`", () => {
  // jira `search_issues` is GET+POST on one path — two variants.
  const jqlRule = (over: Partial<SimRuleRow>) =>
    simRow({
      action: "allow",
      targets: [
        targetRow({
          kind: "network",
          hostPattern: "api.atlassian.com",
          pathPattern: "/ex/jira/*/rest/api/3/search/jql",
          ...over.targets?.[0],
        }),
      ],
      ...over,
    });

  const searchVerdict = async (
    rows: SimRuleRow[],
    viewerSeesOrgRules = true,
  ) => {
    armStubs({
      projectRows: rows.filter((r) => r.scope === "project"),
      orgRows: rows.filter((r) => r.scope === "organization"),
    });
    const result = await effectiveAppPermissions(
      { provider: "jira", agentId: "agent-1" },
      { ...PROJECT_CTX, viewerSeesOrgRules },
    );
    return result.groups
      .flatMap((g) => g.tools)
      .find((t) => t.toolId === "search_issues")!;
  };

  it("two DIFFERENT rules each allowing one method → `allow`, attribution dropped", async () => {
    const getRule = jqlRule({
      id: "r-get",
      logicalId: "get-rule",
      name: "Allow JQL GET",
      targets: [
        targetRow({
          kind: "network",
          hostPattern: "api.atlassian.com",
          pathPattern: "/ex/jira/*/rest/api/3/search/jql",
          method: "GET",
        }),
      ],
    });
    const postRule = jqlRule({
      id: "r-post",
      logicalId: "post-rule",
      name: "Allow JQL POST",
      targets: [
        targetRow({
          kind: "network",
          hostPattern: "api.atlassian.com",
          pathPattern: "/ex/jira/*/rest/api/3/search/jql",
          method: "POST",
        }),
      ],
    });
    const search = await searchVerdict([getRule, postRule]);
    // Pre-fix this folded provenance into the key → `mixed`. Now: uniform allow.
    expect(search.verdict).toBe("allow");
    expect(search.decidedBy).toBeNull(); // two sources — can't name one
  });

  it("the verdict is viewer-INDEPENDENT (two org rules, member vs admin agree)", async () => {
    const orgGet = jqlRule({
      id: "o-get",
      scope: "organization",
      projectId: null,
      organizationId: "org-1",
      logicalId: "og",
      name: "Org GET",
      targets: [
        targetRow({
          kind: "network",
          hostPattern: "api.atlassian.com",
          pathPattern: "/ex/jira/*/rest/api/3/search/jql",
          method: "GET",
        }),
      ],
    });
    const orgPost = jqlRule({
      id: "o-post",
      scope: "organization",
      projectId: null,
      organizationId: "org-1",
      logicalId: "op",
      name: "Org POST",
      targets: [
        targetRow({
          kind: "network",
          hostPattern: "api.atlassian.com",
          pathPattern: "/ex/jira/*/rest/api/3/search/jql",
          method: "POST",
        }),
      ],
    });
    const asAdmin = await searchVerdict([orgGet, orgPost], true);
    const asMember = await searchVerdict([orgGet, orgPost], false);
    expect(asAdmin.verdict).toBe("allow");
    expect(asMember.verdict).toBe("allow"); // NOT mixed for one, allow for the other
  });
});

describe("fencing", () => {
  it("a foreign agent is NOT FOUND via the fenced where", async () => {
    armStubs({ agent: null });
    await expect(
      effectiveAppPermissions(
        { provider: "gmail", agentId: "foreign-agent" },
        PROJECT_CTX,
      ),
    ).rejects.toThrow("Agent not found");
    expect(whereOf("agent")).toEqual({
      id: "foreign-agent",
      projectId: "p1",
    });
  });

  it("an unknown provider is NOT FOUND before any rule read", async () => {
    await expect(
      effectiveAppPermissions({ provider: "no-such-app" }, PROJECT_CTX),
    ).rejects.toThrow("No permission catalog");
    expect(state.calls.filter((c) => c.model === "policyRuleV2")).toHaveLength(
      0,
    );
  });
});

describe("redaction (the simulate contract)", () => {
  const BAIT = "SECRET-ORG-RULE-NAME-BAIT";
  const orgBlock = () =>
    simRow({
      id: "ob1",
      scope: "organization",
      projectId: null,
      organizationId: "org-1",
      logicalId: "org-l1",
      name: BAIT,
      action: "block",
      targets: [targetRow({ kind: "app", appProvider: "gmail" })],
    });

  it("a non-admin viewer never receives the org rule's name or logicalId", async () => {
    armStubs({ orgRows: [orgBlock()] });
    const result = await effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1" },
      { ...PROJECT_CTX, viewerSeesOrgRules: false },
    );
    const tool = result.groups[0]!.tools[0]!;
    expect(tool.verdict).toBe("block");
    expect(tool.decidedBy).toEqual({
      kind: "rule",
      scope: "organization",
      redacted: true,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(BAIT);
    expect(serialized).not.toContain("org-l1");
  });

  it("an org-admin viewer sees the full org rule ref", async () => {
    armStubs({ orgRows: [orgBlock()] });
    const result = await effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1" },
      PROJECT_CTX,
    );
    expect(result.groups[0]!.tools[0]!.decidedBy).toMatchObject({
      kind: "rule",
      scope: "organization",
      rule: { logicalId: "org-l1", name: BAIT },
    });
  });

  it("modifier values survive redaction (the accepted disclosure)", async () => {
    const orgRate = simRow({
      id: "or1",
      scope: "organization",
      projectId: null,
      organizationId: "org-1",
      logicalId: "org-rate",
      name: BAIT,
      action: "allow",
      rateLimit: 25,
      rateLimitWindow: "hour",
      targets: [targetRow({ kind: "app", appProvider: "gmail" })],
    });
    armStubs({ orgRows: [orgRate] });
    const result = await effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1" },
      { ...PROJECT_CTX, viewerSeesOrgRules: false },
    );
    const tool = result.groups[0]!.tools[0]!;
    expect(tool.verdict).toBe("allow");
    expect(tool.rateLimit).toBe(25);
    expect(tool.rateLimitWindow).toBe("hour");
    expect(tool.decidedBy).toEqual({
      kind: "rule",
      scope: "organization",
      redacted: true,
    });
    expect(JSON.stringify(result)).not.toContain(BAIT);
  });
});

describe("baseline honesty", () => {
  const identityScopedBlock = () =>
    simRow({
      id: "ob2",
      scope: "organization",
      projectId: null,
      organizationId: "org-1",
      logicalId: "org-grp",
      name: "Group-only block",
      action: "block",
      identities: [identityRow({ agentGroupId: "ag1" })],
      targets: [targetRow({ kind: "app", appProvider: "gmail" })],
    });

  it("the baseline skips identity-scoped rules and counts them (admin viewer)", async () => {
    armStubs({ orgRows: [identityScopedBlock()] });
    const result = await effectiveAppPermissions(
      { provider: "gmail" }, // no agentId → baseline
      PROJECT_CTX,
    );
    // The group-scoped block does NOT bite the baseline…
    for (const group of result.groups) {
      for (const tool of group.tools) {
        expect(tool.verdict).toBe("unmanaged");
      }
    }
    // …but the response discloses that identity-scoped rules exist.
    expect(result.variesByIdentity).toBe(1);
    expect(result.basis.agentId).toBeNull();
  });

  it("the variesByIdentity count is viewer-scoped (org rules are org information)", async () => {
    armStubs({ orgRows: [identityScopedBlock()] });
    const result = await effectiveAppPermissions(
      { provider: "gmail" },
      { ...PROJECT_CTX, viewerSeesOrgRules: false },
    );
    expect(result.variesByIdentity).toBe(0);
  });

  it("an agent IN the group gets the identity-scoped verdict", async () => {
    armStubs({ orgRows: [identityScopedBlock()] });
    state.results.set("agentGroupMember.findMany", [{ agentGroupId: "ag1" }]);
    const result = await effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1" },
      PROJECT_CTX,
    );
    for (const group of result.groups) {
      for (const tool of group.tools) {
        expect(tool.verdict).toBe("block");
      }
    }
  });
});

describe("org-scope variant", () => {
  it("evaluates org rules only, agent-less", async () => {
    const orgAllow = simRow({
      id: "o1",
      scope: "organization",
      projectId: null,
      organizationId: "org-1",
      logicalId: "org-allow",
      name: "Org allow",
      action: "allow",
      targets: [targetRow({ kind: "app", appProvider: "gmail" })],
    });
    armStubs({ orgRows: [orgAllow] });

    const result = await effectiveAppPermissions(
      { provider: "gmail" },
      {
        scope: "organization",
        organizationId: "org-1",
        viewerSeesOrgRules: true,
      },
    );

    // Only the org side was read — no project-scoped rule load happened. There
    // are two reads (the decision set and the injection set, which differ by
    // whether `equipment` is included); BOTH must be org-scoped.
    const ruleReads = state.calls.filter(
      (c) => c.model === "policyRuleV2" && c.op === "findMany",
    );
    expect(ruleReads.length).toBeGreaterThan(0);
    for (const read of ruleReads) {
      expect((read.args as { where: { scope: string } }).where.scope).toBe(
        "organization",
      );
    }
    expect(result.basis.scope).toBe("organization");
    for (const group of result.groups) {
      for (const tool of group.tools) {
        expect(tool.verdict).toBe("allow");
      }
    }
  });

  it("rejects an agent-scoped request at org scope", async () => {
    await expect(
      effectiveAppPermissions(
        { provider: "gmail", agentId: "agent-1" },
        {
          scope: "organization",
          organizationId: "org-1",
          viewerSeesOrgRules: true,
        },
      ),
    ).rejects.toThrow("project-level");
  });
});

describe("the no-endpoint-leak constraint", () => {
  it("the response serializes no endpoint mapping keys or hosts", async () => {
    armStubs({
      orgRows: [
        simRow({
          id: "o1",
          scope: "organization",
          projectId: null,
          organizationId: "org-1",
          logicalId: "org-allow",
          name: "Org allow",
          action: "allow",
          targets: [targetRow({ kind: "app", appProvider: "gmail" })],
        }),
      ],
      probeConnections: [{ provider: "gmail" }],
    });
    const result = await effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1" },
      PROJECT_CTX,
    );
    const serialized = JSON.stringify(result);
    for (const leaked of [
      "hostPattern",
      "pathPattern",
      "aliasPatterns",
      "gmail.googleapis.com",
      "/gmail/v1",
      "oc-any",
    ]) {
      expect(serialized).not.toContain(leaked);
    }
  });
});
