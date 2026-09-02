import { beforeEach, describe, expect, it, vi } from "vitest";

// The effective-app-permissions reflection's contracts (step 9.7b): the
// AGREEMENT LAW (per-tool verdicts ≡ an independent per-variant composition of
// the real evaluator on the same seeded rules), org/workspace fencing at the
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
      workspaceAccess: model("workspaceAccess"),
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
    scope: "workspace",
    workspaceId: "p1",
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
  workspaceHosts: [] as string[],
  orgHosts: [] as string[],
};
const emptyProviders = new Map<string, string>();

// ── stub arming ──────────────────────────────────────────────────────────────

const AGENT = { id: "agent-1", workspaceId: "p1" };

/** Arm the concurrent reads: rules by scope; the two secret reads told apart by
 * their select shape (loadSecretHosts selects id/scope, the probe doesn't); the
 * two appConnection reads by the probe's status filter. */
const armStubs = (opts: {
  orgRows?: SimRuleRow[];
  workspaceRows?: SimRuleRow[];
  agent?: { id: string } | null;
  probeConnections?: { provider: string }[];
  providerRows?: { id: string; provider: string }[];
}) => {
  // `undefined` = the default agent; an explicit `null` = not found (fence).
  state.results.set(
    "agent.findFirst",
    opts.agent !== undefined ? opts.agent : AGENT,
  );
  // Honour `source: { not: … }` so the DECISION load (equipment dropped) and
  // the INJECTION load (equipment kept) genuinely differ — without this a test
  // passes whichever of the two the code happens to read.
  state.responders.set("policyRuleV2.findMany", (args) => {
    const where = (
      args as { where: { scope: string; source?: { not?: string } } }
    ).where;
    const rows =
      where.scope === "organization"
        ? (opts.orgRows ?? [])
        : (opts.workspaceRows ?? []);
    const excluded = where.source?.not;
    return rows.filter(
      (r: { source?: string }) =>
        excluded === undefined || (r.source ?? "custom") !== excluded,
    );
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
      // Mirror `synthesizeBody`: GraphQL-tagged tools evaluate with a
      // representative body of their own kind, exactly like the reflection.
      const body =
        tool.graphqlOps === "query"
          ? JSON.stringify({ query: "query { oc-any }" })
          : tool.graphqlOps === "mutation"
            ? JSON.stringify({ query: "mutation { oc-any }" })
            : undefined;
      for (const variant of allRuleVariants(tool)) {
        const outcome: PolicyOutcome = evaluatePolicyOutcome(rules, {
          host,
          path: subst(variant.pathPattern),
          method: variant.method ?? "GET",
          body,
          agentId: "agent-1",
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

const WORKSPACE_CTX = {
  scope: "workspace" as const,
  workspaceId: "p1",
  organizationId: "org-1",
  viewerSeesOrgRules: true,
};

// ─────────────────────────────────────────────────────────────────────────────

describe("the agreement law (per-tool verdicts ≡ the evaluator)", () => {
  it("matches an independent per-variant composition across ALL gmail tools", async () => {
    const orgAllow = simRow({
      id: "o1",
      scope: "organization",
      workspaceId: null,
      organizationId: "org-1",
      logicalId: "org-allow",
      name: "Org gmail rate",
      action: "allow",
      rateLimit: 100,
      rateLimitWindow: "minute",
      priority: 1,
      targets: [targetRow({ kind: "app", appProvider: "gmail" })],
    });
    const workspaceBlock = simRow({
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
    // Step 7: the injection basis comes from the agent's grants, never a pool.
    const gmailGrant = simRow({
      id: "r-grant",
      logicalId: "grant-gmail",
      name: "Grant gmail",
      action: "allow",
      priority: 1000,
      identities: [identityRow({ id: "i-grant", agentId: "agent-1" })],
      targets: [
        targetRow({
          id: "t-grant",
          kind: "app",
          appProvider: "gmail",
          appConnectionScope: "workspace",
        }),
      ],
    });
    armStubs({
      orgRows: [orgAllow],
      workspaceRows: [workspaceBlock, gmailGrant],
      probeConnections: [{ provider: "gmail" }],
    });

    const result = await effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1" },
      WORKSPACE_CTX,
    );

    const expected = expectedVerdicts(
      "gmail",
      [orgAllow, workspaceBlock, gmailGrant],
      {
        hasInjections: true, // the grant attaches every gmail host
      },
    );
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

  it("github graphql: the panel splits the shared /graphql endpoint by operation kind", async () => {
    // The Manage-permissions scenario the discrimination exists for: a grant
    // stack with graphql_mutation (and create_pull) set to Never and
    // graphql_query allowed. The panel must show exactly what the gateway
    // enforces: queries allowed, mutations blocked - never the
    // pre-discrimination lie where the shared endpoint read as one verdict.
    // (Rule order is irrelevant here BY DESIGN: the body discrimination, not
    // stack ordering, splits the shared endpoint.)
    const blocked = simRow({
      id: "r-blocked",
      logicalId: "gh-blocked",
      name: "GitHub: blocked",
      action: "block",
      priority: 1,
      identities: [identityRow({ id: "i-b", agentId: "agent-1" })],
      targets: [
        targetRow({
          kind: "app",
          appProvider: "github",
          appTools: ["create_pull", "graphql_mutation"],
        }),
      ],
    });
    const allowed = simRow({
      id: "r-allowed",
      logicalId: "gh-allowed",
      name: "GitHub: allowed",
      action: "allow",
      priority: 2,
      identities: [identityRow({ id: "i-a", agentId: "agent-1" })],
      targets: [
        targetRow({
          id: "t-allowed",
          kind: "app",
          appProvider: "github",
          appTools: ["graphql_query", "list_pulls"],
        }),
      ],
    });
    const terminal = simRow({
      id: "r-terminal",
      logicalId: "gh-terminal",
      name: "GitHub: everything else",
      action: "block",
      priority: 3,
      identities: [identityRow({ id: "i-t", agentId: "agent-1" })],
      targets: [targetRow({ kind: "app", appProvider: "github" })],
    });
    armStubs({ workspaceRows: [blocked, allowed, terminal] });

    const result = await effectiveAppPermissions(
      { provider: "github", agentId: "agent-1" },
      WORKSPACE_CTX,
    );
    const actual = new Map(
      result.groups.flatMap((g) => g.tools.map((t) => [t.toolId, t.verdict])),
    );
    // The two rows share POST api.github.com /graphql, yet each shows its own
    // setting - the discrimination at work.
    expect(actual.get("graphql_query")).toBe("allow");
    expect(actual.get("graphql_mutation")).toBe("block");
    expect(actual.get("create_pull")).toBe("block");
    expect(actual.get("list_pulls")).toBe("allow");
    // And the agreement law still holds across the whole catalog.
    const expected = expectedVerdicts("github", [blocked, allowed, terminal], {
      hasInjections: false,
    });
    expect(actual).toEqual(expected);
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
    armStubs({ workspaceRows: [postBlock] });

    const result = await effectiveAppPermissions(
      { provider: "jira", agentId: "agent-1" },
      WORKSPACE_CTX,
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
    const workspaceDefault = simRow({
      id: "d1",
      logicalId: "default",
      name: "Default",
      isDefault: true,
      source: "default",
      action: "block",
      priority: 10_000,
    });
    armStubs({ workspaceRows: [workspaceDefault] });

    const result = await effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1" },
      WORKSPACE_CTX,
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
    const workspaceDefault = simRow({
      id: "d1",
      logicalId: "default",
      name: "Default",
      isDefault: true,
      source: "default",
      action: "block",
      priority: 10_000,
    });
    armStubs({
      workspaceRows: [
        workspaceDefault,
        // Step 7: attachment comes from a grant, not a pool. EQUIPMENT-source:
        // it feeds the injection basis but is dropped from decisions — the
        // injected-yet-undecided shape this carve exists for (an ordinary
        // attach's allow would first-match past the default).
        simRow({
          id: "r-grant",
          logicalId: "grant-gmail",
          name: "Grant gmail",
          action: "allow",
          source: "equipment",
          identities: [identityRow({ id: "i-grant", agentId: "agent-1" })],
          targets: [
            targetRow({
              id: "t-grant",
              kind: "app",
              appProvider: "gmail",
              appConnectionScope: "workspace",
            }),
          ],
        }),
      ],
      probeConnections: [{ provider: "gmail" }],
    });

    const result = await effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1" },
      WORKSPACE_CTX,
    );

    expect(result.basis.credentialAttached).toBe(true);
    for (const group of result.groups) {
      for (const tool of group.tools) {
        expect(tool.verdict).toBe("block");
        expect(tool.decidedBy).toEqual({ kind: "default", scope: "workspace" });
      }
    }
  });

  it("F1: a selective agent's RULE-GRANTED connection makes its tools managed, not unmanaged", async () => {
    // Selective agent, ZERO assigned credentials, a workspace allow rule granting
    // connection c1 (gmail) narrowed to reads, + workspace Default Block. The
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
    const workspaceDefault = simRow({
      id: "d1",
      logicalId: "default",
      name: "Default",
      isDefault: true,
      source: "default",
      action: "block",
      priority: 10_000,
    });
    armStubs({
      agent: { id: "agent-1" },
      workspaceRows: [grant, workspaceDefault],
      // c1 resolves to gmail via loadConnectionProviders; it is NOT in the
      // assigned pool (probeConnections empty) — only the RULE grants it.
      providerRows: [{ id: "c1", provider: "gmail" }],
    });

    const result = await effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1" },
      WORKSPACE_CTX,
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
    workspaceHosts: ["api.secretco.com"],
    orgHosts: [] as string[],
  };
  const CONN_PROVIDERS = new Map([["c1", "gmail"]]);
  const PRINCIPALS = { userIds: [], groupIds: [] };

  const probeFor = (
    agent: { id: string } | null,
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
    const probe = probeFor({ id: "agent-1" }, [connGrant()]);
    expect(probe("gmail.googleapis.com")).toBe(true);
    expect(probe("api.unrelated.com")).toBe(false);
  });

  it("folds a secretScope pool grant to the level's hosts", () => {
    const probe = probeFor({ id: "agent-1" }, [
      connGrant({
        targets: [targetRow({ kind: "secret", secretScope: "workspace" })],
      }),
    ]);
    expect(probe("api.secretco.com")).toBe(true);
  });

  it("PLANTED BAIT: an empty-identity rule is NEVER folded (injection is explicit-only)", () => {
    const probe = probeFor({ id: "agent-1" }, [connGrant({ identities: [] })]);
    expect(probe("gmail.googleapis.com")).toBe(false);
  });

  it("skips block rules and app targets WITHOUT connectionScope", () => {
    const probe = probeFor({ id: "agent-1" }, [
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
      workspaceRows: rows.filter((r) => r.scope === "workspace"),
      orgRows: rows.filter((r) => r.scope === "organization"),
    });
    const result = await effectiveAppPermissions(
      { provider: "jira", agentId: "agent-1" },
      { ...WORKSPACE_CTX, viewerSeesOrgRules },
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
      workspaceId: null,
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
      workspaceId: null,
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
        WORKSPACE_CTX,
      ),
    ).rejects.toThrow("Agent not found");
    expect(whereOf("agent")).toEqual({
      id: "foreign-agent",
      workspaceId: "p1",
    });
  });

  it("an unknown provider is NOT FOUND before any rule read", async () => {
    await expect(
      effectiveAppPermissions({ provider: "no-such-app" }, WORKSPACE_CTX),
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
      workspaceId: null,
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
      { ...WORKSPACE_CTX, viewerSeesOrgRules: false },
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
      WORKSPACE_CTX,
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
      workspaceId: null,
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
      { ...WORKSPACE_CTX, viewerSeesOrgRules: false },
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
      workspaceId: null,
      organizationId: "org-1",
      logicalId: "org-grp",
      name: "Group-only block",
      action: "block",
      identities: [identityRow({ groupId: "g1" })],
      targets: [targetRow({ kind: "app", appProvider: "gmail" })],
    });

  it("the baseline skips identity-scoped rules and counts them (admin viewer)", async () => {
    armStubs({ orgRows: [identityScopedBlock()] });
    const result = await effectiveAppPermissions(
      { provider: "gmail" }, // no agentId → baseline
      WORKSPACE_CTX,
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
      { ...WORKSPACE_CTX, viewerSeesOrgRules: false },
    );
    expect(result.variesByIdentity).toBe(0);
  });

  it("an agent whose workspace inherits the group gets the identity-scoped verdict", async () => {
    armStubs({ orgRows: [identityScopedBlock()] });
    // The workspace grants group g1 via WorkspaceAccess → g1 lands in the
    // resolved principal set (org-fenced by the group read).
    state.results.set("workspaceAccess.findMany", [
      { userId: null, groupId: "g1" },
    ]);
    state.results.set("group.findMany", [{ id: "g1" }]);
    const result = await effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1" },
      WORKSPACE_CTX,
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
      workspaceId: null,
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

    // Only the org side was read — no workspace-scoped rule load happened. There
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
    ).rejects.toThrow("workspace-level");
  });
});

describe("the no-endpoint-leak constraint", () => {
  it("the response serializes no endpoint mapping keys or hosts", async () => {
    armStubs({
      orgRows: [
        simRow({
          id: "o1",
          scope: "organization",
          workspaceId: null,
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
      WORKSPACE_CTX,
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

describe("per-connection reflection (decisions bind to the winner)", () => {
  const connAllow = () =>
    simRow({
      id: "ca1",
      logicalId: "lca1",
      name: "allow work gmail",
      action: "allow",
      priority: 1,
      identities: [identityRow({ agentId: "agent-1" })],
      targets: [targetRow({ kind: "connection", appConnectionId: "c-work" })],
    });
  const denyDefault = () =>
    simRow({
      id: "dd1",
      logicalId: "ldd1",
      name: "Default Rule",
      action: "block",
      isDefault: true,
      source: "default",
      priority: 100,
      targets: [],
    });
  const arm = () =>
    armStubs({
      workspaceRows: [connAllow(), denyDefault()],
      providerRows: [
        { id: "c-work", provider: "gmail" },
        { id: "c-personal", provider: "gmail" },
      ],
      probeConnections: [{ provider: "gmail" }],
    });

  it("folds per-account disagreement to `mixed` at the provider level", async () => {
    arm();
    const result = await effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1" },
      WORKSPACE_CTX,
    );
    const tools = result.groups.flatMap((g) => g.tools);
    expect(tools.length).toBeGreaterThan(0);
    // Allow via c-work, deny-default via c-personal — the only truthful
    // provider-level answer is `mixed`, never a silent one-account view.
    expect(tools.every((t) => t.verdict === "mixed")).toBe(true);
    // The resolved connection target is identity-scoped → the baseline-visible
    // varies counter includes it (the new `connection` relevance arm).
    expect(result.variesByIdentity).toBe(1);
  });

  it("reflects one account exactly: allow via the granted one, deny-default via the sibling", async () => {
    arm();
    state.results.set("appConnection.findFirst", { id: "c-work" });
    const work = await effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1", connectionId: "c-work" },
      WORKSPACE_CTX,
    );
    expect(
      work.groups.flatMap((g) => g.tools).every((t) => t.verdict === "allow"),
    ).toBe(true);

    arm();
    state.results.set("appConnection.findFirst", { id: "c-personal" });
    const personal = await effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1", connectionId: "c-personal" },
      WORKSPACE_CTX,
    );
    expect(
      personal.groups
        .flatMap((g) => g.tools)
        .every((t) => t.verdict === "block"),
    ).toBe(true);
  });

  it("fences a foreign/mismatched connection id as NOT FOUND", async () => {
    arm();
    state.results.set("appConnection.findFirst", null);
    await expect(
      effectiveAppPermissions(
        { provider: "gmail", agentId: "agent-1", connectionId: "c-foreign" },
        WORKSPACE_CTX,
      ),
    ).rejects.toThrow("Connection not found");
  });
});

describe("orgCeiling (the org level evaluated alone)", () => {
  const orgRow = (over: Partial<SimRuleRow>) =>
    simRow({
      scope: "organization",
      organizationId: "org-1",
      workspaceId: null,
      ...over,
    });
  const gmailApp = () => [targetRow({ kind: "app", appProvider: "gmail" })];
  const flat = (r: Awaited<ReturnType<typeof effectiveAppPermissions>>) => {
    const tools = r.groups.flatMap((g) => g.tools);
    // Guard against vacuous per-tool loops: gmail's catalog is never empty.
    expect(tools.length).toBeGreaterThan(0);
    return tools;
  };

  it("stays visible under a STRICTER workspace rule (the invisible-floor case)", async () => {
    armStubs({
      orgRows: [
        orgRow({
          id: "oa1",
          logicalId: "loa1",
          name: "org approval",
          action: "allow",
          requireApproval: true,
          targets: gmailApp(),
        }),
      ],
      workspaceRows: [
        simRow({
          id: "pb1",
          logicalId: "lpb1",
          name: "workspace block",
          action: "block",
          targets: [targetRow({ kind: "app", appProvider: "gmail" })],
        }),
      ],
      probeConnections: [{ provider: "gmail" }],
    });
    const result = await effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1" },
      WORKSPACE_CTX,
    );
    for (const tool of flat(result)) {
      // The combined verdict is the stricter workspace block…
      expect(tool.verdict).toBe("block");
      expect(
        tool.decidedBy?.kind === "rule" && tool.decidedBy.scope === "workspace",
      ).toBe(true);
      // …and the org floor is STILL reported — the whole point of the field.
      expect(tool.orgCeiling).toBe("approval");
    }
  });

  it("reports an org rule block as the ceiling", async () => {
    armStubs({
      orgRows: [
        orgRow({
          id: "ob1",
          logicalId: "lob1",
          name: "org block",
          action: "block",
          targets: gmailApp(),
        }),
      ],
      workspaceRows: [
        simRow({
          id: "pa1",
          logicalId: "lpa1",
          name: "workspace allow",
          action: "allow",
          targets: [targetRow({ kind: "app", appProvider: "gmail" })],
        }),
      ],
      probeConnections: [{ provider: "gmail" }],
    });
    const result = await effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1" },
      WORKSPACE_CTX,
    );
    for (const tool of flat(result)) {
      expect(tool.verdict).toBe("block");
      expect(tool.orgCeiling).toBe("block");
    }
  });

  it("is null when the org is silent", async () => {
    armStubs({
      workspaceRows: [
        simRow({
          id: "pa2",
          logicalId: "lpa2",
          name: "workspace allow",
          action: "allow",
          targets: [targetRow({ kind: "app", appProvider: "gmail" })],
        }),
      ],
      probeConnections: [{ provider: "gmail" }],
    });
    const result = await effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1" },
      WORKSPACE_CTX,
    );
    for (const tool of flat(result)) {
      expect(tool.verdict).toBe("allow");
      expect(tool.orgCeiling).toBeNull();
    }
  });

  it("honors the enforce-deny carve: an org default Block is NO ceiling for uncredentialed traffic", async () => {
    armStubs({
      orgRows: [
        orgRow({
          id: "od1",
          logicalId: "lod1",
          name: "Default Rule",
          action: "block",
          isDefault: true,
          source: "default",
          priority: 100,
        }),
      ],
      // No probe connections and no secrets → hasInjections false.
    });
    const result = await effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1" },
      WORKSPACE_CTX,
    );
    for (const tool of flat(result)) {
      expect(tool.verdict).toBe("unmanaged");
      expect(tool.orgCeiling).toBeNull();
    }
  });

  it("reports the org default Block as the ceiling for credentialed traffic", async () => {
    armStubs({
      orgRows: [
        orgRow({
          id: "od2",
          logicalId: "lod2",
          name: "Default Rule",
          action: "block",
          isDefault: true,
          source: "default",
          priority: 100,
        }),
      ],
      probeConnections: [{ provider: "gmail" }],
      workspaceRows: [
        // Step 7: attachment comes from a grant, not a pool.
        simRow({
          id: "r-grant",
          logicalId: "grant-gmail",
          name: "Grant gmail",
          action: "allow",
          identities: [identityRow({ id: "i-grant", agentId: "agent-1" })],
          targets: [
            targetRow({
              id: "t-grant",
              kind: "app",
              appProvider: "gmail",
              appConnectionScope: "workspace",
            }),
          ],
        }),
      ],
    });
    const result = await effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1" },
      WORKSPACE_CTX,
    );
    for (const tool of flat(result)) {
      expect(tool.verdict).toBe("block");
      expect(tool.decidedBy).toEqual({
        kind: "default",
        scope: "organization",
      });
      expect(tool.orgCeiling).toBe("block");
    }
  });
});

describe("orgResources (the org resource floor mirror)", () => {
  const orgConnAllow = (id: string, conditions: unknown): SimRuleRow =>
    simRow({
      id,
      scope: "organization",
      workspaceId: null,
      organizationId: "org-1",
      logicalId: `l-${id}`,
      name: `org ${id}`,
      action: "allow",
      conditions: conditions as SimRuleRow["conditions"],
      identities: [identityRow({ id: `i-${id}`, agentId: "agent-1" })],
      targets: [
        targetRow({
          id: `t-${id}`,
          kind: "connection",
          appConnectionId: "conn-1",
        }),
      ],
    });

  const reflect = (viewerSeesOrgRules = true) =>
    effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1", connectionId: "conn-1" },
      { ...WORKSPACE_CTX, viewerSeesOrgRules },
    );

  it("exposes an identity-matched org session policy — values-only, viewer-independent", async () => {
    armStubs({ orgRows: [orgConnAllow("o1", { repositories: ["org/a"] })] });
    state.results.set("appConnection.findFirst", { id: "conn-1" });
    expect((await reflect()).orgResources).toEqual({
      repositories: ["org/a"],
    });
    // The documented disclosure: a non-admin sees the VALUES (never the rule).
    expect((await reflect(false)).orgResources).toEqual({
      repositories: ["org/a"],
    });
  });

  it("a later condition-less allow row cannot clear the boundary", async () => {
    // A plain org attach of the same connection restricts nothing, so it is not
    // a boundary — letting it win by sorting later would make the effective
    // scope depend on unrelated rule ordering. (Deliberately NOT the
    // last-match-wins law a scope's own selection follows.)
    armStubs({
      orgRows: [
        orgConnAllow("o1", { repositories: ["org/a"] }),
        orgConnAllow("o2", null),
      ],
    });
    state.results.set("appConnection.findFirst", { id: "conn-1" });
    expect((await reflect()).orgResources).toEqual({
      repositories: ["org/a"],
    });
  });

  it("several org rules constraining one connection all apply", async () => {
    armStubs({
      orgRows: [
        orgConnAllow("o1", { repositories: ["org/a", "org/b"] }),
        orgConnAllow("o2", { repositories: ["org/b", "org/c"] }),
      ],
    });
    state.results.set("appConnection.findFirst", { id: "conn-1" });
    expect((await reflect()).orgResources).toEqual({
      repositories: ["org/b"],
    });
  });

  it("an explicit-identity org grant and an org-wide boundary compose (gateway parity)", async () => {
    // The gateway folds the org GRANT's own policy and every matching boundary;
    // this is the shape where a naive reflection would report more reach than
    // the gateway actually allows.
    const explicitGrant = orgConnAllow("o1", { repositories: ["org/x"] });
    explicitGrant.identities = [identityRow({ id: "i-a", agentId: "agent-1" })];
    armStubs({
      orgRows: [
        explicitGrant,
        orgConnAllow("o2", { repositories: ["org/x", "org/y"] }),
      ],
    });
    state.results.set("appConnection.findFirst", { id: "conn-1" });
    const result = await reflect();
    expect(result.orgResources).toEqual({ repositories: ["org/x"] });
    expect(result.effectiveResources).toEqual({ repositories: ["org/x"] });
  });

  it("behavioral array conditions are not a policy (the is_object mirror)", async () => {
    armStubs({
      orgRows: [orgConnAllow("o1", [{ type: "body_contains", value: "x" }])],
    });
    state.results.set("appConnection.findFirst", { id: "conn-1" });
    expect((await reflect()).orgResources).toBeNull();
  });

  it("another agent's org rule never floors this agent", async () => {
    const foreign = orgConnAllow("o1", { repositories: ["org/a"] });
    foreign.identities = [identityRow({ id: "i-x", agentId: "agent-2" })];
    armStubs({ orgRows: [foreign] });
    state.results.set("appConnection.findFirst", { id: "conn-1" });
    expect((await reflect()).orgResources).toBeNull();
  });

  it("workspace rows never feed it, and it is null without an explicit connection", async () => {
    const workspacePolicy = simRow({
      id: "p1r",
      logicalId: "l-p1r",
      name: "workspace grant",
      action: "allow",
      source: "grant",
      conditions: { folders: ["/x"] } as SimRuleRow["conditions"],
      identities: [identityRow({ id: "i-p", agentId: "agent-1" })],
      targets: [
        targetRow({
          id: "t-p",
          kind: "connection",
          appConnectionId: "conn-1",
        }),
      ],
    });
    armStubs({ workspaceRows: [workspacePolicy] });
    state.results.set("appConnection.findFirst", { id: "conn-1" });
    expect((await reflect()).orgResources).toBeNull();

    armStubs({ orgRows: [orgConnAllow("o1", { repositories: ["org/a"] })] });
    const noConnection = await effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1" },
      WORKSPACE_CTX,
    );
    expect(noConnection.orgResources).toBeNull();
  });
});

describe("resource scopes (org boundary ∩ workspace selection)", () => {
  const connTarget = (id: string) =>
    targetRow({ id: `t-${id}`, kind: "connection", appConnectionId: "conn-1" });

  const orgRule = (
    id: string,
    conditions: unknown,
    identities: SimRuleRow["identities"] = [],
  ): SimRuleRow =>
    simRow({
      id,
      scope: "organization",
      workspaceId: null,
      organizationId: "org-1",
      logicalId: `l-${id}`,
      name: `org ${id}`,
      action: "allow",
      conditions: conditions as SimRuleRow["conditions"],
      identities,
      targets: [connTarget(id)],
    });

  const workspaceGrant = (conditions: unknown): SimRuleRow =>
    simRow({
      id: "p-grant",
      logicalId: "l-p-grant",
      name: "workspace grant",
      source: "grant",
      action: "allow",
      conditions: conditions as SimRuleRow["conditions"],
      identities: [identityRow({ id: "i-p", agentId: "agent-1" })],
      targets: [connTarget("p")],
    });

  const reflect = async (opts: {
    orgRows?: SimRuleRow[];
    workspaceRows?: SimRuleRow[];
  }) => {
    armStubs(opts);
    state.results.set("appConnection.findFirst", { id: "conn-1" });
    return effectiveAppPermissions(
      { provider: "gmail", agentId: "agent-1", connectionId: "conn-1" },
      WORKSPACE_CTX,
    );
  };

  it("an org rule naming NO identity bounds this agent — the reported case", () => {
    // The authoring shape an admin reaches for ("applies to every agent").
    // Under the injection law it bound nothing; as a BOUNDARY it must bind.
    return reflect({
      orgRows: [
        orgRule("o1", { repositories: ["buckle/electron", "buckle/api"] }),
      ],
      workspaceRows: [workspaceGrant({ repositories: ["buckle/api"] })],
    }).then((result) => {
      expect(result.orgResources).toEqual({
        repositories: ["buckle/electron", "buckle/api"],
      });
      expect(result.effectiveResources).toEqual({
        repositories: ["buckle/api"],
      });
    });
  });

  it("a workspace pick outside the boundary composes to nothing", async () => {
    const result = await reflect({
      orgRows: [orgRule("o1", { repositories: ["org/a"] })],
      workspaceRows: [workspaceGrant({ repositories: ["org/z"] })],
    });
    expect(result.effectiveResources).toEqual({ repositories: [] });
  });

  it("either scope alone stands on its own", async () => {
    const orgOnly = await reflect({
      orgRows: [orgRule("o1", { folders: ["/clients"] })],
      workspaceRows: [workspaceGrant(null)],
    });
    expect(orgOnly.effectiveResources).toEqual({ folders: ["/clients"] });

    const workspaceOnly = await reflect({
      workspaceRows: [workspaceGrant({ folders: ["/clients/acme"] })],
    });
    expect(workspaceOnly.orgResources).toBeNull();
    expect(workspaceOnly.effectiveResources).toEqual({
      folders: ["/clients/acme"],
    });
  });

  it("an org boundary for a group the agent is not in does not bind", async () => {
    const result = await reflect({
      orgRows: [
        orgRule("o1", { repositories: ["org/a"] }, [
          identityRow({ id: "i-g", groupId: "other-group" }),
        ]),
      ],
      workspaceRows: [workspaceGrant({ repositories: ["proj/b"] })],
    });
    expect(result.orgResources).toBeNull();
    expect(result.effectiveResources).toEqual({ repositories: ["proj/b"] });
  });
});
