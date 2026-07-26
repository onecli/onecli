import { beforeEach, describe, expect, it, vi } from "vitest";

// The effective-credentials reflection's contracts (step 9.7b, EFFECTIVE-access
// framing): each credential the agent can inject is tagged with what it can DO
// under the rules (Usable / Limited / Blocked) — an all-mode agent BLOCKED from
// a provider reads "Blocked", not "available" (the user's reported case). Plus
// the inject_select injectable-set law (all-mode pool / selective assigned ∪
// rule grants, explicit-identity-only, pool grants expanded), the org+project
// fence on rule-named ids (cross-org bait), and collapsed org redaction. The db
// is mocked at the boundary; queries are routed by their where/select shape.

const state = vi.hoisted(() => ({
  calls: [] as { model: string; op: string; args: unknown }[],
  responders: new Map<string, (args: unknown) => unknown>(),
  aggregate: { _max: { generation: 1 as number | null } },
}));

const record = vi.hoisted(
  () =>
    (model: string) =>
    (op: string) =>
    async (args: unknown): Promise<unknown> => {
      state.calls.push({ model, op, args });
      if (op === "aggregate") return state.aggregate;
      const responder = state.responders.get(`${model}.${op}`);
      return responder ? responder(args) : [];
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

const { effectiveCredentials } = await import("./effective-credentials");
import type { SimRuleRow } from "../policy-simulate/load-rules";

beforeEach(() => {
  state.calls = [];
  state.responders = new Map();
  state.aggregate = { _max: { generation: 1 } };
});

// ── row builders ─────────────────────────────────────────────────────────────

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
    action: "allow",
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

// ── stub routing (by where/select shape) ─────────────────────────────────────

type SecretRow = {
  id: string;
  name: string;
  hostPattern: string;
  scope?: string;
  projectId?: string | null;
};
type ConnRow = {
  id: string;
  label: string | null;
  provider: string;
  scope?: string;
  projectId?: string | null;
};

const armStubs = (opts: {
  agent?: { id: string; secretMode: string } | null;
  orgRows?: SimRuleRow[];
  projectRows?: SimRuleRow[];
  poolSecrets?: SecretRow[];
  poolConnections?: ConnRow[];
  ruleSecrets?: SecretRow[];
  ruleConnections?: ConnRow[];
  scopeSecrets?: SecretRow[];
  scopeConnections?: ConnRow[];
}) => {
  state.responders.set("agent.findFirst", () =>
    opts.agent !== undefined
      ? opts.agent
      : { id: "agent-1", secretMode: "all" },
  );
  // Honour the `source: { not: … }` filter so the DECISION load (equipment
  // dropped) and the INJECTION load (equipment kept) genuinely differ — without
  // this a test passes whichever load the code uses.
  state.responders.set("policyRuleV2.findMany", (args) => {
    const where = (
      args as {
        where: { scope: string; source?: { not?: string } };
      }
    ).where;
    const rows =
      where.scope === "organization"
        ? (opts.orgRows ?? [])
        : (opts.projectRows ?? []);
    const excluded = where.source?.not;
    return rows.filter(
      (r: { source?: string }) =>
        excluded === undefined || (r.source ?? "custom") !== excluded,
    );
  });
  state.responders.set("secret.findMany", (args) => {
    const a = args as {
      where: Record<string, unknown>;
      select: Record<string, boolean>;
    };
    if (a.where.id) return opts.ruleSecrets ?? [];
    if (a.select.scope && !a.select.name) return []; // loadSecretHosts
    if (a.select.scope && a.select.name) return opts.scopeSecrets ?? []; // scope-expand
    return opts.poolSecrets ?? []; // all-mode pool
  });
  state.responders.set("appConnection.findMany", (args) => {
    const a = args as {
      where: Record<string, unknown>;
      select: Record<string, boolean>;
    };
    if (a.where.id) return opts.ruleConnections ?? [];
    if (a.where.provider) return opts.scopeConnections ?? [];
    if (!a.select.label) return []; // loadConnectionProviders (id/provider)
    return opts.poolConnections ?? []; // all-mode pool
  });
};

const CTX = {
  projectId: "p1",
  organizationId: "org-1",
  viewerSeesOrgRules: true,
};

// ─────────────────────────────────────────────────────────────────────────────

describe("the effective-access framing (the user's case)", () => {
  it("all-mode: a connection BLOCKED by a rule reads `blocked`, another reads `usable`", async () => {
    // NanoClaw is all-mode (whole pool: gmail + github). A rule blocks it from
    // gmail's whole app. gmail must read `blocked`, github `usable`.
    const blockGmail = simRow({
      logicalId: "block-gmail",
      name: "Block NanoClaw from gmail",
      action: "block",
      identities: [identityRow({ agentId: "agent-1" })],
      targets: [
        targetRow({
          kind: "app",
          appProvider: "gmail",
          appConnectionScope: "project",
        }),
      ],
    });
    armStubs({
      agent: { id: "agent-1", secretMode: "all" },
      projectRows: [blockGmail],
      poolConnections: [
        { id: "c-gmail", label: "Support Gmail", provider: "gmail" },
        { id: "c-gh", label: "Repo", provider: "github" },
      ],
    });

    const result = await effectiveCredentials("agent-1", CTX);

    expect(result.mode).toBe("all");
    const byId = new Map(result.connections.map((c) => [c.id, c]));
    expect(byId.get("c-gmail")?.status).toBe("blocked");
    expect(byId.get("c-gh")?.status).toBe("usable");
    // All-mode credentials carry no per-item provenance (the footnote explains).
    expect(byId.get("c-gmail")?.provenance).toEqual([]);
  });

  it("a connection whose tools all need approval reads `limited` (same shared rollup as the agent dialog)", async () => {
    const approveGmail = simRow({
      logicalId: "approve-gmail",
      name: "Approve all gmail",
      action: "allow",
      requireApproval: true,
      identities: [identityRow({ agentId: "agent-1" })],
      targets: [targetRow({ kind: "app", appProvider: "gmail" })],
    });
    armStubs({
      agent: { id: "agent-1", secretMode: "all" },
      projectRows: [approveGmail],
      poolConnections: [
        { id: "c-gmail", label: "Support Gmail", provider: "gmail" },
      ],
    });

    const result = await effectiveCredentials("agent-1", CTX);
    expect(result.connections[0]?.status).toBe("limited"); // NOT "usable"
  });

  it("a secret whose host a rule blocks reads `blocked`", async () => {
    const blockHost = simRow({
      logicalId: "block-host",
      name: "Block the API host",
      action: "block",
      identities: [identityRow({ agentId: "agent-1" })],
      targets: [
        targetRow({
          kind: "network",
          hostPattern: "api.secretco.com",
          pathPattern: "*",
        }),
      ],
    });
    armStubs({
      agent: { id: "agent-1", secretMode: "all" },
      projectRows: [blockHost],
      poolSecrets: [
        { id: "s1", name: "API_KEY", hostPattern: "api.secretco.com" },
        { id: "s2", name: "OTHER", hostPattern: "api.other.com" },
      ],
    });

    const result = await effectiveCredentials("agent-1", CTX);
    const byId = new Map(result.secrets.map((s) => [s.id, s]));
    expect(byId.get("s1")?.status).toBe("blocked");
    expect(byId.get("s2")?.status).toBe("usable");
  });
});

describe("the injectable set (inject_select mirror)", () => {
  it("selective: every attachment comes from a rule, EQUIPMENT included", async () => {
    // The old per-agent assignments became `source="equipment"` rules at the
    // cutover, and the gateway's `inject_select` walks them like any other. If
    // this read the DECISION set (which drops equipment) the agent's credential
    // would vanish here while the gateway still injects it.
    armStubs({
      agent: { id: "agent-1", secretMode: "selective" },
      projectRows: [
        simRow({
          logicalId: "equip-gmail",
          name: "Gmail",
          source: "equipment",
          identities: [identityRow({ agentId: "agent-1" })],
          targets: [targetRow({ kind: "connection", appConnectionId: "c1" })],
        }),
        simRow({
          logicalId: "grant-gh",
          name: "GitHub for agent-1",
          identities: [identityRow({ agentId: "agent-1" })],
          targets: [targetRow({ kind: "connection", appConnectionId: "c2" })],
        }),
      ],
      ruleConnections: [
        { id: "c1", label: "Gmail", provider: "gmail" },
        { id: "c2", label: "Repo", provider: "github" },
      ],
    });

    const result = await effectiveCredentials("agent-1", CTX);
    expect(result.mode).toBe("selective");
    const byId = new Map(result.connections.map((c) => [c.id, c]));
    expect(byId.get("c1")?.provenance).toEqual([
      {
        kind: "rule",
        scope: "project",
        rule: { logicalId: "equip-gmail", name: "Gmail" },
      },
    ]);
    expect(byId.get("c2")?.provenance).toEqual([
      {
        kind: "rule",
        scope: "project",
        rule: { logicalId: "grant-gh", name: "GitHub for agent-1" },
      },
    ]);
    expect(byId.get("c1")?.status).toBe("usable");
    expect(byId.get("c2")?.status).toBe("usable");
  });

  it("PLANTED BAIT: an empty-identity allow rule NEVER grants a credential", async () => {
    armStubs({
      agent: { id: "agent-1", secretMode: "selective" },
      projectRows: [
        simRow({
          logicalId: "bait",
          name: "Any-identity allow",
          identities: [],
          targets: [targetRow({ kind: "connection", appConnectionId: "cx" })],
        }),
      ],
      ruleConnections: [{ id: "cx", label: "Bait", provider: "gmail" }],
    });
    const result = await effectiveCredentials("agent-1", CTX);
    expect(result.connections).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("cx");
  });

  it("a secretScope grant EXPANDS to each project secret, tagged with the rule", async () => {
    armStubs({
      agent: { id: "agent-1", secretMode: "selective" },
      projectRows: [
        simRow({
          logicalId: "pool",
          name: "All project secrets",
          identities: [identityRow({ agentId: "agent-1" })],
          targets: [targetRow({ kind: "secret", secretScope: "project" })],
        }),
      ],
      scopeSecrets: [
        {
          id: "s1",
          name: "A",
          hostPattern: "api.a.com",
          scope: "project",
          projectId: "p1",
        },
        {
          id: "s2",
          name: "B",
          hostPattern: "api.b.com",
          scope: "project",
          projectId: "p1",
        },
      ],
    });
    const result = await effectiveCredentials("agent-1", CTX);
    expect(result.secrets.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    expect(result.secrets[0]?.provenance).toEqual([
      {
        kind: "rule",
        scope: "project",
        rule: { logicalId: "pool", name: "All project secrets" },
      },
    ]);
  });
});

describe("fencing + redaction", () => {
  it("a foreign agent is NOT FOUND via the fenced where", async () => {
    armStubs({ agent: null });
    await expect(effectiveCredentials("foreign", CTX)).rejects.toThrow(
      "Agent not found",
    );
    const call = state.calls.find((c) => c.model === "agent");
    expect((call?.args as { where: unknown }).where).toEqual({
      id: "foreign",
      projectId: "p1",
    });
  });

  it("CROSS-ORG BAIT: a rule-named foreign secret resolves to nothing", async () => {
    armStubs({
      agent: { id: "agent-1", secretMode: "selective" },
      projectRows: [
        simRow({
          logicalId: "evil",
          name: "Names a foreign secret",
          identities: [identityRow({ agentId: "agent-1" })],
          targets: [targetRow({ kind: "secret", secretId: "foreign-secret" })],
        }),
      ],
      ruleSecrets: [], // the fenced id-in resolve returns nothing
    });
    const result = await effectiveCredentials("agent-1", CTX);
    expect(result.secrets).toHaveLength(0);
    // the resolve carried the org+project fence.
    const resolve = state.calls.filter(
      (c) =>
        c.model === "secret" &&
        (c.args as { where: { id?: unknown } }).where.id,
    )[0];
    expect((resolve?.args as { where: unknown }).where).toEqual({
      id: { in: ["foreign-secret"] },
      OR: [
        { projectId: "p1" },
        { organizationId: "org-1", scope: "organization" },
      ],
    });
  });

  const BAIT = "SECRET-ORG-RULE-NAME-BAIT";
  const orgGrant = (logicalId: string, name: string) =>
    simRow({
      id: logicalId,
      scope: "organization",
      projectId: null,
      organizationId: "org-1",
      logicalId,
      name,
      identities: [identityRow({ id: logicalId, agentId: "agent-1" })],
      targets: [
        targetRow({ id: logicalId, kind: "connection", appConnectionId: "c1" }),
      ],
    });

  it("a non-admin sees ONE redacted marker for multiple org grants (no name, no count)", async () => {
    armStubs({
      agent: { id: "agent-1", secretMode: "selective" },
      // c1 is named by BOTH org rules — the fenced id-in resolve returns it once
      // and the two org grants must collapse to a single redacted marker.
      ruleConnections: [{ id: "c1", label: "Gmail", provider: "gmail" }],
      orgRows: [orgGrant("org-a", BAIT), orgGrant("org-b", `${BAIT}-2`)],
    });
    const result = await effectiveCredentials("agent-1", {
      ...CTX,
      viewerSeesOrgRules: false,
    });
    expect(result.connections[0]?.provenance).toEqual([
      { kind: "rule", scope: "organization", redacted: true },
    ]);
    const json = JSON.stringify(result);
    expect(json).not.toContain(BAIT);
    expect(json).not.toContain("org-a");
    expect(json).not.toContain("org-b");
  });

  it("an org-admin sees the named org grant (the bait is non-vacuous)", async () => {
    armStubs({
      agent: { id: "agent-1", secretMode: "selective" },
      ruleConnections: [{ id: "c1", label: "Gmail", provider: "gmail" }],
      orgRows: [orgGrant("org-a", BAIT)],
    });
    const result = await effectiveCredentials("agent-1", CTX);
    expect(result.connections[0]?.provenance).toContainEqual({
      kind: "rule",
      scope: "organization",
      rule: { logicalId: "org-a", name: BAIT },
    });
  });
});
