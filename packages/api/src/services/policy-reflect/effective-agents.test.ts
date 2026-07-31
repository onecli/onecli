import { beforeEach, describe, expect, it, vi } from "vitest";

// The effective-agents reflection's contracts (step 9.7b): the CREDENTIAL axis
// mirrors the gateway's inject_select laws (full for all-mode; viaRule for
// explicit-identity rule grants — INCLUDING `equipment` ones — naming THIS
// connection or its provider pool; empty identities never grant), the
// DECISIONS rollup rides the shared per-tool core, the fence mirrors
// assertConnectionVisible (org-scoped rows visible, foreign orgs not), the
// catalog-less axis is honestly absent, and the principal set resolves ONCE
// per call however many agents (it is project-derived). The db is mocked at
// the boundary; wheres are recorded and asserted.

const state = vi.hoisted(() => ({
  calls: [] as { model: string; op: string; args: unknown }[],
  results: new Map<string, unknown>(),
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
      if (op === "count") return (state.results.get(key) as number) ?? 0;
      return (
        state.results.get(key) ??
        (op === "findFirst" || op === "findUnique" ? null : [])
      );
    },
);

vi.mock("@onecli/db", () => {
  const model = (name: string) => ({
    findMany: record(name)("findMany"),
    findFirst: record(name)("findFirst"),
    findUnique: record(name)("findUnique"),
    aggregate: record(name)("aggregate"),
    count: record(name)("count"),
  });
  return {
    Prisma: {},
    db: {
      project: model("project"),
      agent: model("agent"),
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

const { effectiveAgents } = await import("./effective-agents");
const { getAppPermissionDefinition } =
  await import("../../apps/app-permissions");
import type { SimRuleRow } from "../policy-simulate/load-rules";

beforeEach(() => {
  state.calls = [];
  state.results = new Map();
  state.responders = new Map();
  state.aggregate = { _max: { generation: 1 } };
});

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

const CTX = {
  projectId: "p1",
  organizationId: "org-1",
  viewerSeesOrgRules: true,
};

const GMAIL_CONNECTION = {
  id: "conn-1",
  provider: "gmail",
  scope: "project",
};

const armStubs = (opts: {
  connection?: { id: string; provider: string; scope: string } | null;
  agents?: { id: string; name: string }[];
  orgRows?: SimRuleRow[];
  projectRows?: SimRuleRow[];
}) => {
  state.results.set("project.findUnique", { organizationId: "org-1" });
  state.results.set(
    "appConnection.findFirst",
    opts.connection !== undefined ? opts.connection : GMAIL_CONNECTION,
  );
  state.results.set(
    "agent.findMany",
    opts.agents ?? [{ id: "agent-1", name: "Support bot" }],
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
        : (opts.projectRows ?? []);
    const excluded = where.source?.not;
    return rows.filter(
      (r: { source?: string }) =>
        excluded === undefined || (r.source ?? "custom") !== excluded,
    );
  });
};

const totalGmailTools = () => {
  const def = getAppPermissionDefinition("gmail");
  return def ? def.groups.reduce((n, g) => n + g.tools.length, 0) : 0;
};

describe("the credential axis (the old dialog's meaning)", () => {
  it("viaRule for an EQUIPMENT grant, none otherwise", async () => {
    // The old per-agent assignment rows became `source="equipment"` rules at the
    // cutover. They are dropped from the decision set, so reading that set here
    // would report "none" for an agent the gateway still injects for.
    armStubs({
      agents: [
        { id: "a-equipped", name: "Equipped" },
        { id: "a-none", name: "None" },
      ],
      projectRows: [
        simRow({
          logicalId: "equip",
          name: "Gmail",
          source: "equipment",
          identities: [identityRow({ agentId: "a-equipped" })],
          targets: [
            targetRow({ kind: "connection", appConnectionId: "conn-1" }),
          ],
        }),
      ],
    });

    const result = await effectiveAgents("conn-1", CTX);

    expect(result.agents.map((a) => [a.agentId, a.credential])).toEqual([
      [
        "a-equipped",
        {
          status: "viaRule",
          provenance: [
            {
              kind: "rule",
              scope: "project",
              rule: { logicalId: "equip", name: "Gmail" },
            },
          ],
        },
      ],
      ["a-none", { status: "none" }],
    ]);
  });

  it("viaRule for a connection-target grant with an explicit identity; empty identities NEVER grant", async () => {
    armStubs({
      agents: [
        { id: "a-granted", name: "Granted" },
        { id: "a-other", name: "Other" },
      ],
      projectRows: [
        simRow({
          logicalId: "grant",
          name: "Gmail for granted",
          identities: [identityRow({ agentId: "a-granted" })],
          targets: [
            targetRow({ kind: "connection", appConnectionId: "conn-1" }),
          ],
        }),
        // PLANTED BAIT: empty identities = "any" for decisions, NEVER for
        // injection — must not attach for anyone.
        simRow({
          id: "r-bait",
          logicalId: "bait",
          name: "Any-identity allow",
          identities: [],
          targets: [
            targetRow({
              id: "t9",
              kind: "connection",
              appConnectionId: "conn-1",
            }),
          ],
        }),
      ],
    });

    const result = await effectiveAgents("conn-1", CTX);

    expect(result.agents[0]?.credential).toEqual({
      status: "viaRule",
      provenance: [
        {
          kind: "rule",
          scope: "project",
          rule: { logicalId: "grant", name: "Gmail for granted" },
        },
      ],
    });
    expect(result.agents[1]?.credential).toEqual({ status: "none" });
  });

  it("viaRule for an app+connectionScope pool grant matching provider AND level; mismatches don't grant", async () => {
    armStubs({
      agents: [{ id: "a-1", name: "A" }],
      projectRows: [
        simRow({
          logicalId: "pool",
          name: "Gmail project pool",
          identities: [identityRow({ agentId: "a-1" })],
          targets: [
            targetRow({
              kind: "app",
              appProvider: "gmail",
              appConnectionScope: "project",
            }),
          ],
        }),
        // Wrong level (org pool, project connection) — no grant.
        simRow({
          id: "r2",
          logicalId: "wrong-level",
          name: "Gmail org pool",
          identities: [identityRow({ id: "i2", agentId: "a-1" })],
          targets: [
            targetRow({
              id: "t2",
              kind: "app",
              appProvider: "gmail",
              appConnectionScope: "organization",
            }),
          ],
        }),
        // Wrong provider — no grant.
        simRow({
          id: "r3",
          logicalId: "wrong-provider",
          name: "Slack pool",
          identities: [identityRow({ id: "i3", agentId: "a-1" })],
          targets: [
            targetRow({
              id: "t3",
              kind: "app",
              appProvider: "slack",
              appConnectionScope: "project",
            }),
          ],
        }),
        // App target WITHOUT connectionScope is block/allow only — no grant.
        simRow({
          id: "r4",
          logicalId: "no-scope",
          name: "Gmail allow",
          identities: [identityRow({ id: "i4", agentId: "a-1" })],
          targets: [targetRow({ id: "t4", kind: "app", appProvider: "gmail" })],
        }),
      ],
    });

    const result = await effectiveAgents("conn-1", CTX);

    expect(result.agents[0]?.credential).toEqual({
      status: "viaRule",
      provenance: [
        {
          kind: "rule",
          scope: "project",
          rule: { logicalId: "pool", name: "Gmail project pool" },
        },
      ],
    });
  });
});

describe("the decisions rollup", () => {
  it("counts reachable tools per agent from the shared per-tool core", async () => {
    // A block rule scoped to agent-2 only: agent-1 keeps every tool reachable
    // (unmanaged — no credential probe hits), agent-2 loses them all.
    armStubs({
      agents: [
        { id: "agent-1", name: "Free" },
        { id: "agent-2", name: "Blocked" },
      ],
      projectRows: [
        simRow({
          logicalId: "block-2",
          name: "Block agent-2 gmail",
          action: "block",
          identities: [identityRow({ agentId: "agent-2" })],
          targets: [targetRow({ kind: "app", appProvider: "gmail" })],
        }),
      ],
    });

    const result = await effectiveAgents("conn-1", CTX);
    const total = totalGmailTools();

    expect(result.catalog).toBe(true);
    expect(result.agents[0]?.decisions).toEqual({
      allowedTools: total,
      totalTools: total,
      anyApproval: false,
      anyRateLimit: false,
    });
    expect(result.agents[1]?.decisions).toEqual({
      allowedTools: 0,
      totalTools: total,
      anyApproval: false,
      anyRateLimit: false,
    });
  });

  it("a catalog-less provider has NO decisions axis (never '0 of 0')", async () => {
    armStubs({
      connection: {
        id: "conn-x",
        provider: "no-catalog-app",
        scope: "project",
      },
      agents: [{ id: "a-1", name: "A" }],
      projectRows: [
        simRow({
          logicalId: "grant-x",
          name: "Grant conn-x",
          identities: [identityRow({ agentId: "a-1" })],
          targets: [
            targetRow({ kind: "connection", appConnectionId: "conn-x" }),
          ],
        }),
      ],
    });

    const result = await effectiveAgents("conn-x", CTX);

    expect(result.catalog).toBe(false);
    expect(result.agents[0]?.decisions).toBeNull();
    expect(result.agents[0]?.credential).toMatchObject({ status: "viaRule" });
  });
});

describe("the effective-access headline (the user decision)", () => {
  it("derives access: blocked / usable / none / unknown", async () => {
    armStubs({
      agents: [
        { id: "a-usable", name: "Free" },
        { id: "a-blocked", name: "Blocked" },
        { id: "a-none", name: "Unattached" },
      ],
      projectRows: [
        simRow({
          logicalId: "grant-usable",
          name: "Grant Free",
          identities: [identityRow({ agentId: "a-usable" })],
          targets: [
            targetRow({ kind: "connection", appConnectionId: "conn-1" }),
          ],
        }),
        simRow({
          id: "r2",
          logicalId: "grant-blocked",
          name: "Grant Blocked",
          identities: [identityRow({ id: "i2", agentId: "a-blocked" })],
          targets: [
            targetRow({
              id: "t2",
              kind: "connection",
              appConnectionId: "conn-1",
            }),
          ],
        }),
        simRow({
          id: "r3",
          logicalId: "block-b",
          name: "Block Blocked from gmail",
          action: "block",
          identities: [identityRow({ id: "i3", agentId: "a-blocked" })],
          targets: [targetRow({ id: "t3", kind: "app", appProvider: "gmail" })],
        }),
      ],
    });

    const result = await effectiveAgents("conn-1", CTX);
    const byId = new Map(result.agents.map((a) => [a.agentId, a.access]));
    // granted + every gmail tool reachable → usable
    expect(byId.get("a-usable")).toBe("usable");
    // granted + a whole-app gmail block → every tool blocked → blocked
    expect(byId.get("a-blocked")).toBe("blocked");
    // no rule grant → no credential → none
    expect(byId.get("a-none")).toBe("none");
  });

  it("a catalog-less connection is `unknown` (attached, can't evaluate tools)", async () => {
    armStubs({
      connection: {
        id: "conn-x",
        provider: "no-catalog-app",
        scope: "project",
      },
      agents: [{ id: "a-1", name: "A" }],
      projectRows: [
        simRow({
          logicalId: "grant-x",
          name: "Grant conn-x",
          identities: [identityRow({ agentId: "a-1" })],
          targets: [
            targetRow({ kind: "connection", appConnectionId: "conn-x" }),
          ],
        }),
      ],
    });
    const result = await effectiveAgents("conn-x", CTX);
    expect(result.agents[0]?.access).toBe("unknown");
  });

  it("all-approval reads `limited`, NOT `usable` (the shared rollup — matches the credential dialog)", async () => {
    // Every gmail tool needs approval → allowedTools===total but it isn't
    // freely usable. The shared rollupToolStatus must say "limited".
    armStubs({
      agents: [{ id: "a-1", name: "A" }],
      projectRows: [
        simRow({
          logicalId: "grant-1",
          name: "Grant conn-1",
          identities: [identityRow({ agentId: "a-1" })],
          targets: [
            targetRow({ kind: "connection", appConnectionId: "conn-1" }),
          ],
        }),
        simRow({
          id: "r2",
          logicalId: "approve-all",
          name: "Approve all gmail",
          action: "allow",
          requireApproval: true,
          identities: [identityRow({ id: "i2", agentId: "a-1" })],
          targets: [targetRow({ id: "t2", kind: "app", appProvider: "gmail" })],
        }),
      ],
    });
    const result = await effectiveAgents("conn-1", CTX);
    const agent = result.agents[0];
    expect(agent?.decisions?.anyApproval).toBe(true);
    expect(agent?.decisions?.allowedTools).toBe(agent?.decisions?.totalTools);
    expect(agent?.access).toBe("limited"); // NOT "usable"
  });
});

describe("fencing", () => {
  it("a foreign connection is NOT FOUND via the mirrored OR fence", async () => {
    armStubs({ connection: null });
    await expect(effectiveAgents("foreign-conn", CTX)).rejects.toThrow(
      "Connection not found",
    );
    const fence = state.calls.find((c) => c.model === "appConnection");
    expect((fence?.args as { where: unknown }).where).toEqual({
      id: "foreign-conn",
      OR: [
        { projectId: "p1" },
        { organizationId: "org-1", scope: "organization" },
      ],
    });
  });

  it("an org-scoped connection resolves via the org arm", async () => {
    armStubs({
      connection: { id: "conn-org", provider: "gmail", scope: "organization" },
      agents: [],
    });
    const result = await effectiveAgents("conn-org", CTX);
    expect(result.connectionId).toBe("conn-org");
    expect(result.agents).toEqual([]);
  });
});

describe("batching", () => {
  it("resolves the principal set with ONE ProjectAccess read, however many agents", async () => {
    armStubs({
      agents: [
        { id: "a-1", name: "A" },
        { id: "a-2", name: "B" },
        { id: "a-3", name: "C" },
      ],
    });

    await effectiveAgents("conn-1", CTX);

    expect(state.calls.filter((c) => c.model === "projectAccess")).toHaveLength(
      1,
    );
  });
});

describe("redaction", () => {
  const BAIT = "SECRET-ORG-RULE-NAME-BAIT";

  it("org-rule viaRule provenance collapses to one redacted marker for members", async () => {
    armStubs({
      agents: [{ id: "a-1", name: "A" }],
      orgRows: [
        simRow({
          id: "o1",
          scope: "organization",
          projectId: null,
          organizationId: "org-1",
          logicalId: "org-a",
          name: BAIT,
          identities: [identityRow({ agentId: "a-1" })],
          targets: [
            targetRow({ kind: "connection", appConnectionId: "conn-1" }),
          ],
        }),
        simRow({
          id: "o2",
          scope: "organization",
          projectId: null,
          organizationId: "org-1",
          logicalId: "org-b",
          name: `${BAIT}-2`,
          identities: [identityRow({ id: "i2", agentId: "a-1" })],
          targets: [
            targetRow({
              id: "t2",
              kind: "connection",
              appConnectionId: "conn-1",
            }),
          ],
        }),
      ],
    });

    const result = await effectiveAgents("conn-1", {
      ...CTX,
      viewerSeesOrgRules: false,
    });

    expect(result.agents[0]?.credential).toEqual({
      status: "viaRule",
      provenance: [{ kind: "rule", scope: "organization", redacted: true }],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(BAIT);
    expect(serialized).not.toContain("org-a");
    expect(serialized).not.toContain("org-b");
  });

  it("an org-admin DOES see the org rule name (proves the member redaction is non-vacuous)", async () => {
    armStubs({
      agents: [{ id: "a-1", name: "A" }],
      orgRows: [
        simRow({
          id: "o1",
          scope: "organization",
          projectId: null,
          organizationId: "org-1",
          logicalId: "org-a",
          name: BAIT,
          identities: [identityRow({ agentId: "a-1" })],
          targets: [
            targetRow({ kind: "connection", appConnectionId: "conn-1" }),
          ],
        }),
      ],
    });

    const result = await effectiveAgents("conn-1", CTX); // admin viewer

    expect(result.agents[0]?.credential).toEqual({
      status: "viaRule",
      provenance: [
        {
          kind: "rule",
          scope: "organization",
          rule: { logicalId: "org-a", name: BAIT },
        },
      ],
    });
  });
});
