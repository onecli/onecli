import { beforeEach, describe, expect, it, vi } from "vitest";

// The grant compiler's laws, at the service layer with the db mocked at the
// boundary (recorder pattern — where/create shapes are asserted; the SQL
// behavior itself is proven by grants-service.pg.test.ts against real PG):
// catalog validation, the plan gate for ask-tools, the org-permitting fence,
// the compiled stack shape, and write-skipping idempotence.

const gate = vi.hoisted(() => ({ assertAllowed: vi.fn(async () => {}) }));

const state = vi.hoisted(() => ({
  calls: [] as { model: string; op: string; args: unknown }[],
  results: new Map<string, unknown>(),
  createSeq: 0,
}));

const record = vi.hoisted(
  () =>
    (model: string) =>
    (op: string) =>
    async (args: unknown): Promise<unknown> => {
      state.calls.push({ model, op, args });
      if (op === "aggregate") {
        return { _max: { priority: 4, generation: 1 } };
      }
      if (op === "create") {
        state.createSeq += 1;
        return { id: `created-${String(state.createSeq)}` };
      }
      const canned = state.results.get(`${model}.${op}`);
      if (typeof canned === "function") return (canned as () => unknown)();
      if (canned !== undefined) return canned;
      if (op === "findMany") return [];
      if (op === "deleteMany") return { count: 0 };
      return null;
    },
);

vi.mock("../providers", () => ({
  getRuleActionGate: () => gate,
}));

vi.mock("@onecli/db", () => {
  const model = (name: string) => ({
    findFirst: record(name)("findFirst"),
    findMany: record(name)("findMany"),
    aggregate: record(name)("aggregate"),
    create: record(name)("create"),
    deleteMany: record(name)("deleteMany"),
  });
  const tx = {
    $executeRaw: async (...args: unknown[]) => {
      state.calls.push({ model: "$lock", op: "executeRaw", args });
      return 0;
    },
    policyRuleV2: model("policyRuleV2"),
    agent: model("agent"),
  };
  return {
    Prisma: { JsonNull: "JsonNull" },
    db: {
      agent: model("agent"),
      appConnection: model("appConnection"),
      secret: model("secret"),
      policyRuleV2: model("policyRuleV2"),
      $transaction: async (cb: (t: typeof tx) => Promise<unknown>) => {
        state.calls.push({ model: "$transaction", op: "begin", args: null });
        return cb(tx);
      },
    },
  };
});

const { registerAppPermission } = await import("../apps/app-permissions");
const { setConnectionGrant, removeConnectionGrant } =
  await import("./grants-service");

registerAppPermission({
  provider: "granttest",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "t-read",
          name: "Read",
          description: "read",
          hostPattern: "api.granttest.example",
          pathPattern: "/read",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "t-write",
          name: "Write",
          description: "write",
          hostPattern: "api.granttest.example",
          pathPattern: "/write",
          method: "POST",
        },
        {
          id: "t-delete",
          name: "Delete",
          description: "delete",
          hostPattern: "api.granttest.example",
          pathPattern: "/delete",
          method: "DELETE",
        },
      ],
    },
  ],
});

const SCOPE = { workspaceId: "p1", organizationId: "org-1" };
const AGENT = { id: "agent-1", name: "Cody" };
const CONNECTION = {
  id: "conn-1",
  provider: "granttest",
  label: "work@example.com",
  scope: "workspace",
};

const callsOf = (model: string, op: string) =>
  state.calls.filter((c) => c.model === model && c.op === op);

const draftCreates = () =>
  callsOf("policyRuleV2", "create")
    .map((c) => (c.args as { data: Record<string, unknown> }).data)
    // The grant stack only — ensureDefault also creates the (draft) Default
    // Rule on first publish, and the snapshot writes published copies.
    .filter((d) => d.status === "draft" && d.isDefault !== true);

beforeEach(() => {
  state.calls = [];
  state.results = new Map();
  state.createSeq = 0;
  gate.assertAllowed.mockClear();
  state.results.set("agent.findFirst", AGENT);
  state.results.set("appConnection.findFirst", CONNECTION);
});

describe("setConnectionGrant", () => {
  it("full access compiles to ONE whole-app allow rule, source-tagged, and publishes", async () => {
    const result = await setConnectionGrant(
      SCOPE,
      "agent-1",
      "conn-1",
      { access: "full" },
      "user-1",
    );
    expect(result.changed).toBe(true);
    const creates = draftCreates();
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      source: "grant",
      action: "allow",
      requireApproval: false,
      name: "Grant: Cody · work@example.com",
    });
    expect(
      (creates[0]?.targets as { create: { appTools: string[] }[] }).create[0]
        ?.appTools,
    ).toEqual([]);
    expect(
      (creates[0]?.identities as { create: unknown[] }).create,
    ).toHaveLength(1);
    // The advisory lock was taken and the draft was snapshot-published.
    expect(callsOf("$lock", "executeRaw").length).toBeGreaterThan(0);
    expect(gate.assertAllowed).not.toHaveBeenCalled();
  });

  it("custom compiles the ordered stack: allow → ask → blocked-complement → approval terminal", async () => {
    await setConnectionGrant(
      SCOPE,
      "agent-1",
      "conn-1",
      { access: "custom", allow: ["t-read"], ask: ["t-write"] },
      "user-1",
    );
    const creates = draftCreates();
    // The terminal "everything else" row NEEDS APPROVAL: requests the catalog
    // does not describe are held for a human, never silently allowed.
    expect(creates).toHaveLength(4);
    expect(creates.map((c) => [c.action, c.requireApproval])).toEqual([
      ["allow", false],
      ["allow", true],
      ["block", false],
      ["allow", true],
    ]);
    expect(creates[3]?.name).toMatch(/: everything else$/);
    const tools = creates.map(
      (c) =>
        (c.targets as { create: { appTools: string[] }[] }).create[0]?.appTools,
    );
    expect(tools[0]).toEqual(["t-read"]);
    expect(tools[1]).toEqual(["t-write"]);
    // The blocked complement = catalog minus chosen; terminal = whole app.
    expect(tools[2]).toEqual(["t-delete"]);
    expect(tools[3]).toEqual([]);
    // Priorities append contiguously at the tail band (aggregate max 4 → 5..8).
    expect(creates.map((c) => c.priority)).toEqual([5, 6, 7, 8]);
    // The approval rows route through the plan gate as manual_approval.
    expect(gate.assertAllowed).toHaveBeenCalledWith(
      { scope: "workspace", workspaceId: "p1" },
      ["manual_approval"],
    );
  });

  it("plan-gates an allow-only custom grant too: its terminal needs approval", async () => {
    await setConnectionGrant(
      SCOPE,
      "agent-1",
      "conn-1",
      { access: "custom", allow: ["t-read"], ask: [] },
      "user-1",
    );
    expect(gate.assertAllowed).toHaveBeenCalledWith(
      { scope: "workspace", workspaceId: "p1" },
      ["manual_approval"],
    );
  });

  it("rejects unknown tool ids naming them (422)", async () => {
    await expect(
      setConnectionGrant(
        SCOPE,
        "agent-1",
        "conn-1",
        { access: "custom", allow: ["nope"], ask: [] },
        "user-1",
      ),
    ).rejects.toThrow('Unknown tool id(s) for "granttest": nope');
  });

  it("rejects per-tool grants for a catalog-less provider, but allows full", async () => {
    state.results.set("appConnection.findFirst", {
      ...CONNECTION,
      provider: "no-catalog-app",
    });
    await expect(
      setConnectionGrant(
        SCOPE,
        "agent-1",
        "conn-1",
        { access: "custom", allow: ["anything"], ask: [] },
        "user-1",
      ),
    ).rejects.toThrow("has none");
    const result = await setConnectionGrant(
      SCOPE,
      "agent-1",
      "conn-1",
      { access: "full" },
      "user-1",
    );
    expect(result.changed).toBe(true);
  });

  it("fences the connection to the workspace + org-shared pool; a miss is NOT_FOUND", async () => {
    state.results.set("appConnection.findFirst", null);
    await expect(
      setConnectionGrant(
        SCOPE,
        "agent-1",
        "conn-foreign",
        { access: "full" },
        "user-1",
      ),
    ).rejects.toThrow("Connection not found");
    const where = (
      callsOf("appConnection", "findFirst")[0]?.args as {
        where: Record<string, unknown>;
      }
    ).where;
    // The attach pool: own workspace OR org-shared under the acting org —
    // deliberately wider than assertTargetsValid, never foreign.
    expect(where).toEqual({
      id: "conn-foreign",
      OR: [
        { workspaceId: "p1" },
        { organizationId: "org-1", scope: "organization" },
      ],
    });
  });

  it("is idempotent: an identical existing stack writes and publishes nothing", async () => {
    state.results.set("policyRuleV2.findMany", [
      {
        id: "r-existing",
        enabled: true,
        action: "allow",
        requireApproval: false,
        name: "Grant: Cody · work@example.com",
        conditions: null,
        identities: [{ agentId: "agent-1", userId: null, groupId: null }],
        targets: [
          { kind: "connection", appConnectionId: "conn-1", appTools: [] },
        ],
      },
    ]);
    const result = await setConnectionGrant(
      SCOPE,
      "agent-1",
      "conn-1",
      { access: "full" },
      "user-1",
    );
    expect(result.changed).toBe(false);
    expect(callsOf("$transaction", "begin")).toHaveLength(0);
    expect(callsOf("policyRuleV2", "create")).toHaveLength(0);
  });
});

/** The catch-alls ("All other reads" / "All other writes") at the service. */
describe("setConnectionGrant: requests not listed in the catalog", () => {
  const custom = { access: "custom" as const, allow: ["t-read"], ask: [] };
  /** A stored grant row, as `readGrantRows` returns it. */
  const stored = (
    suffix: string,
    approval: boolean,
    tools: string[],
    method: string | null = null,
  ) => ({
    id: `r-${suffix}`,
    enabled: true,
    action: "allow",
    requireApproval: approval,
    name: `Grant: Cody · work@example.com: ${suffix}`,
    conditions: null,
    identities: [{ agentId: "agent-1", userId: null, groupId: null }],
    targets: [
      {
        kind: "connection",
        appConnectionId: "conn-1",
        appTools: tools,
        method,
      },
    ],
  });
  /** A stored split: reads Allowed (the plain row), writes Need approval
   * (the stricter row, narrowed to every method but GET/HEAD). */
  const STORED_SPLIT = [
    stored("allowed", false, ["t-read"]),
    stored("blocked", false, ["t-write", "t-delete"]),
    stored("all other writes", true, [], "!GET,HEAD"),
    stored("all other reads", false, []),
  ].map((r) => (r.id === "r-blocked" ? { ...r, action: "block" } : r));
  const catchAlls = () =>
    draftCreates()
      .slice(-2)
      .map((c) => ({
        name: c.name,
        action: c.action,
        requireApproval: c.requireApproval,
        method: (c.targets as { create: { method?: string }[] }).create[0]
          ?.method,
      }));

  it("refuses Always allow when the catalog blocks unlisted requests (422)", async () => {
    registerAppPermission({
      provider: "granttest-closed",
      unlisted: "block",
      groups: [
        {
          category: "read",
          tools: [
            {
              id: "c-read",
              name: "Read",
              description: "read",
              hostPattern: "api.closed.example",
              pathPattern: "/read",
              method: "GET",
            },
          ],
        },
      ],
    });
    state.results.set("appConnection.findFirst", {
      ...CONNECTION,
      provider: "granttest-closed",
    });
    const closed = { access: "custom" as const, allow: ["c-read"], ask: [] };
    for (const choice of [
      { otherReads: "allow" as const },
      { otherWrites: "allow" as const },
    ]) {
      await expect(
        setConnectionGrant(
          SCOPE,
          "agent-1",
          "conn-1",
          { ...closed, ...choice },
          "user-1",
        ),
      ).rejects.toThrow(/not Always allow/);
    }
    expect(callsOf("$transaction", "begin")).toHaveLength(0);
    // Needs approval and Never stay available.
    await setConnectionGrant(
      SCOPE,
      "agent-1",
      "conn-1",
      { ...closed, otherReads: "ask", otherWrites: "never" },
      "user-1",
    );
    expect(catchAlls().map((r) => r.name)).toEqual([
      "Grant: Cody · work@example.com: all other writes",
      "Grant: Cody · work@example.com: all other reads",
    ]);
  });

  it("a save that leaves the catch-alls out keeps the stored ones", async () => {
    state.results.set("policyRuleV2.findMany", STORED_SPLIT);
    // A tools-only save (an older client, the SDK): t-write joins as Ask.
    await setConnectionGrant(
      SCOPE,
      "agent-1",
      "conn-1",
      { ...custom, ask: ["t-write"] },
      "user-1",
    );
    expect(catchAlls()).toEqual([
      {
        name: "Grant: Cody · work@example.com: all other writes",
        action: "allow",
        requireApproval: true,
        method: "!GET,HEAD",
      },
      {
        name: "Grant: Cody · work@example.com: all other reads",
        action: "allow",
        requireApproval: false,
        method: undefined,
      },
    ]);
  });

  it("an explicit choice still replaces the stored one", async () => {
    state.results.set("policyRuleV2.findMany", STORED_SPLIT);
    await setConnectionGrant(
      SCOPE,
      "agent-1",
      "conn-1",
      { ...custom, otherReads: "never", otherWrites: "never" },
      "user-1",
    );
    expect(draftCreates().at(-1)).toMatchObject({
      name: "Grant: Cody · work@example.com: everything else",
      action: "block",
    });
  });

  it("a first customization of a full grant takes the provider default", async () => {
    state.results.set("policyRuleV2.findMany", [
      { ...stored("x", false, []), name: "Grant: Cody · work@example.com" },
    ]);
    await setConnectionGrant(SCOPE, "agent-1", "conn-1", custom, "user-1");
    expect(draftCreates().at(-1)).toMatchObject({
      name: "Grant: Cody · work@example.com: everything else",
      action: "allow",
      requireApproval: true,
    });
  });
});

describe("removeConnectionGrant", () => {
  it("detaching with no existing stack is an idempotent no-op", async () => {
    const result = await removeConnectionGrant(
      SCOPE,
      "agent-1",
      "conn-1",
      "user-1",
    );
    expect(result.changed).toBe(false);
    expect(callsOf("$transaction", "begin")).toHaveLength(0);
  });
});
