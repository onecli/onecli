import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory `@onecli/db` mock covering only what `setAppPermissionsService`
// touches, so the layered (all-agents vs per-agent) reconciliation and the
// wildcard-alignment passes (W1/W2/W3) can be asserted without a database.

interface RuleRow {
  id: string;
  projectId: string | null;
  organizationId: string | null;
  scope: string;
  agentId: string | null;
  name: string;
  hostPattern: string;
  pathPattern: string | null;
  method: string | null;
  action: string;
  enabled: boolean;
  metadata: { source: string; provider: string; toolId: string } | null;
  conditions: unknown;
}

const JSON_NULL = vi.hoisted(() => Symbol("Prisma.JsonNull"));

const store = vi.hoisted(() => ({
  rules: [] as unknown[],
  agents: [] as { id: string; projectId: string }[],
  seq: 0,
}));

const gate = vi.hoisted(() => ({
  assertAllowed: vi.fn(async () => {}),
}));

vi.mock("../providers", () => ({
  getRuleActionGate: () => gate,
}));

vi.mock("@onecli/db", () => {
  const rules = () => store.rules as RuleRow[];

  interface RuleWhere {
    id?: string | { in: string[] };
    projectId?: string;
    organizationId?: string;
    scope?: string;
    AND?: { metadata: { path: string[]; equals: string } }[];
  }

  const KNOWN_WHERE_KEYS = new Set([
    "projectId",
    "organizationId",
    "scope",
    "AND",
    "id",
  ]);

  const matchesWhere = (row: RuleRow, where: RuleWhere): boolean => {
    for (const key of Object.keys(where)) {
      // Fail loudly if the service starts querying with a shape this mock
      // does not model (e.g. an OR-based scopeWhere).
      if (!KNOWN_WHERE_KEYS.has(key)) {
        throw new Error(`unmodeled where key in db mock: ${key}`);
      }
    }
    if (typeof where.id === "string" && row.id !== where.id) return false;
    if (where.projectId !== undefined && row.projectId !== where.projectId)
      return false;
    if (
      where.organizationId !== undefined &&
      row.organizationId !== where.organizationId
    )
      return false;
    if (where.scope !== undefined && row.scope !== where.scope) return false;
    for (const cond of where.AND ?? []) {
      const key = cond.metadata.path[0] as keyof RuleRow["metadata"];
      if (row.metadata?.[key] !== cond.metadata.equals) return false;
    }
    return true;
  };

  const policyRule = {
    findMany: async ({ where }: { where: RuleWhere }) =>
      rules()
        .filter((r) => matchesWhere(r, where))
        .map((r) => ({ ...r })),
    findFirst: async ({ where }: { where: RuleWhere }) => {
      const row = rules().find((r) => matchesWhere(r, where));
      return row ? { ...row } : null;
    },
    deleteMany: async ({
      where,
    }: {
      where: RuleWhere & { id: { in: string[] } };
    }) => {
      const ids = new Set(where.id.in);
      store.rules = rules().filter(
        (r) => !(ids.has(r.id) && matchesWhere(r, where)),
      );
    },
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const row = rules().find((r) => r.id === where.id);
      if (!row) throw new Error(`rule ${where.id} not found`);
      for (const [key, value] of Object.entries(data)) {
        if (value === undefined) continue;
        (row as unknown as Record<string, unknown>)[key] =
          key === "conditions" && value === JSON_NULL ? null : value;
      }
      return row;
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row: RuleRow = {
        id: `r${++store.seq}`,
        projectId: (data.projectId as string) ?? null,
        organizationId: (data.organizationId as string) ?? null,
        scope: (data.scope as string) ?? "project",
        agentId: (data.agentId as string) ?? null,
        name: data.name as string,
        hostPattern: data.hostPattern as string,
        pathPattern: (data.pathPattern as string) ?? null,
        method: (data.method as string) ?? null,
        action: data.action as string,
        enabled: data.enabled as boolean,
        metadata: data.metadata as RuleRow["metadata"],
        conditions: data.conditions ?? null,
      };
      store.rules.push(row);
      return row;
    },
  };

  const db = {
    policyRule,
    agent: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; projectId: string };
      }) =>
        store.agents.find(
          (a) => a.id === where.id && a.projectId === where.projectId,
        ) ?? null,
    },
    $transaction: (
      cb: (tx: { policyRule: typeof policyRule }) => Promise<void>,
    ) => cb({ policyRule }),
  };

  return { db, Prisma: { JsonNull: JSON_NULL } };
});

import { registerAppPermission } from "../apps/app-permissions";
import type { AppTool } from "../apps/app-permissions";
import {
  setAppPermissionsService,
  buildAppPermissionStates,
  listPolicyRules,
  getPolicyRule,
  updatePolicyRule,
  type AppPermissionChange,
} from "./policy-rule-service";

const HOST = "api.testapp.com";

const tool = (id: string, overrides: Partial<AppTool> = {}): AppTool => ({
  id,
  name: `Tool ${id}`,
  description: "",
  hostPattern: HOST,
  pathPattern: `/api/${id}`,
  method: "GET",
  ...overrides,
});

const readAll = tool("read_all", { pathPattern: "/api/*", method: "GET" });
const readOne = tool("read_one");
const readTwo = tool("read_two");
const writeAll = tool("write_all", {
  pathPattern: "/api/*",
  method: undefined,
  methods: ["POST", "DELETE"],
});
const writeOne = tool("write_one", {
  method: undefined,
  methods: ["POST", "DELETE"],
  aliasPatterns: ["/alias/write_one"],
});

registerAppPermission({
  provider: "testapp",
  groups: [
    { category: "read", tools: [readOne, readTwo], wildcard: readAll },
    { category: "write", tools: [writeOne], wildcard: writeAll },
  ],
});

const SCOPE = { projectId: "p1" };
const change = (
  t: AppTool,
  permission: AppPermissionChange["permission"],
): AppPermissionChange => ({ toolId: t.id, permission, tool: t });

const apply = (
  changes: AppPermissionChange[],
  opts: {
    agentId?: string | null;
    conditions?: { target: "body"; operator: "contains"; value: string }[];
    policyMode?: "allow" | "deny";
    scope?: { projectId?: string; organizationId?: string };
  } = {},
) =>
  setAppPermissionsService(
    opts.scope ?? SCOPE,
    "testapp",
    "Test App",
    changes,
    opts.conditions,
    opts.policyMode,
    opts.agentId,
  );

const rowsFor = (toolId: string, agentId: string | null = null) =>
  (store.rules as RuleRow[]).filter(
    (r) => r.metadata?.toolId === toolId && r.agentId === agentId,
  );

beforeEach(() => {
  store.rules = [];
  store.agents = [{ id: "agent-x", projectId: "p1" }];
  store.seq = 0;
  gate.assertAllowed.mockClear();
});

describe("setAppPermissionsService — all-agents layer (existing behavior)", () => {
  it("block creates all-agents rows and allow deletes them (allow mode)", async () => {
    await apply([change(readOne, "block")]);
    expect(rowsFor("read_one")).toHaveLength(1);
    expect(rowsFor("read_one")[0]).toMatchObject({
      agentId: null,
      action: "block",
      pathPattern: "/api/read_one",
      method: "GET",
    });

    await apply([change(readOne, "allow")]);
    expect(rowsFor("read_one")).toHaveLength(0);
  });

  it("writes wildcard rows when no agent overrides exist (W3 negative)", async () => {
    await apply([change(writeAll, "block")]);
    expect(rowsFor("write_all")).toHaveLength(2); // POST + DELETE variants
    expect(rowsFor("write_one")).toHaveLength(0);
  });
});

describe("setAppPermissionsService — agent layer", () => {
  it("partitions layers: an agent write leaves all-agents rows untouched", async () => {
    await apply([change(readOne, "block")]);
    const baseIds = rowsFor("read_one").map((r) => r.id);

    await apply([change(readOne, "manual_approval")], { agentId: "agent-x" });

    expect(rowsFor("read_one")).toHaveLength(1);
    expect(rowsFor("read_one")[0]).toMatchObject({ action: "block" });
    expect(rowsFor("read_one").map((r) => r.id)).toEqual(baseIds);
    expect(rowsFor("read_one", "agent-x")).toHaveLength(1);
    expect(rowsFor("read_one", "agent-x")[0]).toMatchObject({
      action: "manual_approval",
    });
  });

  it("materializes explicit allow rows in allow mode", async () => {
    await apply([change(readOne, "allow")], { agentId: "agent-x" });
    expect(rowsFor("read_one", "agent-x")).toHaveLength(1);
    expect(rowsFor("read_one", "agent-x")[0]).toMatchObject({
      action: "allow",
    });
  });

  it("inherit deletes only that agent's rows", async () => {
    store.agents.push({ id: "agent-y", projectId: "p1" });
    await apply([change(readOne, "block")]);
    await apply([change(readOne, "block")], { agentId: "agent-x" });
    await apply([change(readOne, "block")], { agentId: "agent-y" });

    await apply([change(readOne, "inherit")], { agentId: "agent-x" });

    expect(rowsFor("read_one", "agent-x")).toHaveLength(0);
    expect(rowsFor("read_one", "agent-y")).toHaveLength(1);
    expect(rowsFor("read_one")).toHaveLength(1);
  });

  it("is mode-independent in deny mode: block materializes, inherit deletes", async () => {
    await apply([change(readOne, "block")], {
      agentId: "agent-x",
      policyMode: "deny",
    });
    expect(rowsFor("read_one", "agent-x")).toHaveLength(1);
    expect(rowsFor("read_one", "agent-x")[0]).toMatchObject({
      action: "block",
    });

    await apply([change(readOne, "inherit")], {
      agentId: "agent-x",
      policyMode: "deny",
    });
    expect(rowsFor("read_one", "agent-x")).toHaveLength(0);
  });

  it("creates one row per variant for multi-method + alias tools", async () => {
    await apply([change(writeOne, "block")], { agentId: "agent-x" });
    const rows = rowsFor("write_one", "agent-x");
    // 2 paths (pathPattern + alias) x 2 methods (POST, DELETE)
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => `${r.pathPattern} ${r.method}`)).toEqual(
      expect.arrayContaining([
        "/api/write_one POST",
        "/api/write_one DELETE",
        "/alias/write_one POST",
        "/alias/write_one DELETE",
      ]),
    );
  });
});

describe("wildcard alignment", () => {
  it("W1: an agent wildcard change fans out per-tool and never writes agent wildcard rows", async () => {
    await apply([change(readAll, "block")], { agentId: "agent-x" });

    expect(rowsFor("read_all", "agent-x")).toHaveLength(0);
    expect(rowsFor("read_one", "agent-x")).toHaveLength(1);
    expect(rowsFor("read_two", "agent-x")).toHaveLength(1);
  });

  it("W1: request-explicit per-tool changes win over the fan-out", async () => {
    await apply(
      [change(readAll, "block"), change(readOne, "manual_approval")],
      { agentId: "agent-x" },
    );

    expect(rowsFor("read_one", "agent-x")[0]).toMatchObject({
      action: "manual_approval",
    });
    expect(rowsFor("read_two", "agent-x")[0]).toMatchObject({
      action: "block",
    });
  });

  it("W2: the first agent override expands the all-agents wildcard per-tool, carrying its conditions", async () => {
    const wcConditions = [
      { target: "body" as const, operator: "contains" as const, value: "x" },
    ];
    await apply([change(readAll, "block")], { conditions: wcConditions });
    expect(rowsFor("read_all")).toHaveLength(1);

    await apply([change(readOne, "allow")], { agentId: "agent-x" });

    expect(rowsFor("read_all")).toHaveLength(0);
    for (const toolId of ["read_one", "read_two"]) {
      const rows = rowsFor(toolId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: "block" });
      expect(rows[0]?.conditions).toEqual(wcConditions);
    }
    expect(rowsFor("read_one", "agent-x")).toHaveLength(1);
    expect(rowsFor("read_one", "agent-x")[0]).toMatchObject({
      action: "allow",
    });
    // The agent's own rows never receive the wildcard's conditions.
    expect(rowsFor("read_one", "agent-x")[0]?.conditions).toBeNull();
  });

  it("W3: an all-agents wildcard write goes per-tool while agent overrides exist in the group", async () => {
    await apply([change(readOne, "allow")], { agentId: "agent-x" });

    await apply([change(readAll, "block")]);

    expect(rowsFor("read_all")).toHaveLength(0);
    expect(rowsFor("read_one")).toHaveLength(1);
    expect(rowsFor("read_two")).toHaveLength(1);
    expect(rowsFor("read_one")[0]).toMatchObject({ action: "block" });
  });

  it("W2 never loosens: a per-tool row stricter than the wildcard keeps its action", async () => {
    // manual_approval wildcard + a stricter per-tool block.
    await apply([change(readAll, "manual_approval")]);
    await apply([change(readOne, "block")]);

    await apply([change(readTwo, "allow")], { agentId: "agent-x" });

    expect(rowsFor("read_all")).toHaveLength(0);
    expect(rowsFor("read_one")[0]).toMatchObject({ action: "block" });
    expect(rowsFor("read_two")[0]).toMatchObject({
      action: "manual_approval",
    });
  });

  it("W2 is skipped by inherit-only agent requests", async () => {
    await apply([change(readAll, "block")]);
    await apply([change(readOne, "inherit")], { agentId: "agent-x" });

    expect(rowsFor("read_all")).toHaveLength(1);
  });
});

describe("conditions isolation", () => {
  it("clears conditions when an empty array is provided", async () => {
    await apply([change(readOne, "block")], {
      conditions: [{ target: "body", operator: "contains", value: "x" }],
    });
    expect(rowsFor("read_one")[0]?.conditions).toEqual([
      { target: "body", operator: "contains", value: "x" },
    ]);

    await apply([change(readOne, "block")], { conditions: [] });
    expect(rowsFor("read_one")[0]?.conditions).toBeNull();
  });

  it("stamps conditions only on the target layer's rows", async () => {
    await apply([change(readOne, "block")]);
    await apply([change(readOne, "block")], { agentId: "agent-x" });

    await apply([change(readOne, "block")], {
      agentId: "agent-x",
      conditions: [{ target: "body", operator: "contains", value: "secret" }],
    });

    expect(rowsFor("read_one")[0]?.conditions).toBeNull();
    expect(rowsFor("read_one", "agent-x")[0]?.conditions).toEqual([
      { target: "body", operator: "contains", value: "secret" },
    ]);
  });
});

describe("validation", () => {
  it("rejects an agent target at organization scope", async () => {
    await expect(
      apply([change(readOne, "block")], {
        agentId: "agent-x",
        scope: { organizationId: "o1" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects inherit on the all-agents layer", async () => {
    await expect(apply([change(readOne, "inherit")])).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("rejects an agent that is not in the project", async () => {
    await expect(
      apply([change(readOne, "block")], { agentId: "agent-unknown" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("never passes inherit to the rule-action gate", async () => {
    await apply([change(readOne, "block"), change(readTwo, "inherit")], {
      agentId: "agent-x",
    });
    expect(gate.assertAllowed).toHaveBeenCalledWith(SCOPE, ["block"]);
  });

  it("treats an empty-string agentId as the all-agents layer", async () => {
    await apply([change(readOne, "block")], { agentId: "" });
    expect(rowsFor("read_one")).toHaveLength(1);
    expect(rowsFor("read_one")[0]).toMatchObject({ agentId: null });
  });
});

describe("buildAppPermissionStates", () => {
  type FoldRow = Parameters<typeof buildAppPermissionStates>[0][number];
  const row = (overrides: Partial<FoldRow>): FoldRow =>
    ({
      id: "r1",
      action: "manual_approval",
      conditions: null,
      agentId: null,
      metadata: { source: "app_permission", toolId: "read_one" },
      ...overrides,
    }) as FoldRow;

  it("partitions all-agents rows into defaults and agent rows into byAgent", () => {
    const result = buildAppPermissionStates([
      row({ metadata: { source: "app_permission", toolId: "read_one" } }),
      row({
        id: "r2",
        action: "block",
        agentId: "agent-1",
        metadata: { source: "app_permission", toolId: "send" },
        conditions: [{ field: "body", operator: "contains", value: "x" }],
      }),
      row({ id: "r3", metadata: { note: "no toolId — skipped" } }),
    ]);
    expect(result.defaults).toEqual({
      read_one: { permission: "manual_approval", conditions: [] },
    });
    expect(result.byAgent).toEqual({
      "agent-1": {
        send: {
          permission: "block",
          conditions: [{ field: "body", operator: "contains", value: "x" }],
        },
      },
    });
  });

  it('maps allow-action rows to "allow" (pins the org GET mapping fix)', () => {
    const result = buildAppPermissionStates([
      row({ action: "allow" }),
      row({ id: "r2", action: "block", metadata: { toolId: "send" } }),
    ]);
    expect(result.defaults.read_one?.permission).toBe("allow");
    expect(result.defaults.send?.permission).toBe("block");
  });
});

describe("rule reads redact app-permission endpoint fields", () => {
  const seedRules = () => {
    store.rules = [
      {
        id: "custom-1",
        projectId: "p1",
        organizationId: null,
        scope: "project",
        agentId: null,
        name: "Block deletes",
        hostPattern: "api.example.com",
        pathPattern: "/v1/*",
        method: "DELETE",
        action: "block",
        enabled: true,
        metadata: null,
        conditions: null,
      },
      {
        id: "app-1",
        projectId: "p1",
        organizationId: null,
        scope: "project",
        agentId: null,
        name: "Testapp: Tool read_one",
        hostPattern: HOST,
        pathPattern: "/api/read_one",
        method: "GET",
        action: "manual_approval",
        enabled: true,
        metadata: {
          source: "app_permission",
          provider: "testapp",
          toolId: "read_one",
        },
        conditions: null,
      },
    ] satisfies RuleRow[];
  };

  it("list omits endpoint fields on app rows and keeps them on custom rows", async () => {
    seedRules();
    const result = await listPolicyRules(SCOPE);
    const custom = result.find((r) => r.id === "custom-1");
    const appRule = result.find((r) => r.id === "app-1");

    expect(custom).toMatchObject({
      hostPattern: "api.example.com",
      pathPattern: "/v1/*",
      method: "DELETE",
    });
    expect(appRule).not.toHaveProperty("hostPattern");
    expect(appRule).not.toHaveProperty("pathPattern");
    expect(appRule).not.toHaveProperty("method");
    // The catalog handle survives — it's the public identity of an app rule.
    expect(appRule).toMatchObject({
      name: "Testapp: Tool read_one",
      action: "manual_approval",
      metadata: {
        source: "app_permission",
        provider: "testapp",
        toolId: "read_one",
      },
    });
  });

  it("get omits endpoint fields on an app row and keeps them on a custom row", async () => {
    seedRules();
    const appRule = await getPolicyRule(SCOPE, "app-1");
    expect(appRule).not.toHaveProperty("hostPattern");
    expect(appRule).not.toHaveProperty("pathPattern");
    expect(appRule).not.toHaveProperty("method");

    const custom = await getPolicyRule(SCOPE, "custom-1");
    expect(custom).toMatchObject({ hostPattern: "api.example.com" });
  });
});

describe("updatePolicyRule guards app-permission endpoint fields", () => {
  const seedAppRule = () => {
    store.rules = [
      {
        id: "app-1",
        projectId: "p1",
        organizationId: null,
        scope: "project",
        agentId: null,
        name: "Testapp: Tool read_one",
        hostPattern: HOST,
        pathPattern: "/api/read_one",
        method: "GET",
        action: "manual_approval",
        enabled: true,
        metadata: {
          source: "app_permission",
          provider: "testapp",
          toolId: "read_one",
        },
        conditions: null,
      },
      {
        id: "custom-1",
        projectId: "p1",
        organizationId: null,
        scope: "project",
        agentId: null,
        name: "Block deletes",
        hostPattern: "api.example.com",
        pathPattern: null,
        method: null,
        action: "block",
        enabled: true,
        metadata: null,
        conditions: null,
      },
    ] satisfies RuleRow[];
  };

  it("rejects hostPattern/pathPattern/method edits on an app rule", async () => {
    seedAppRule();
    for (const input of [
      { hostPattern: "evil.example.com" },
      { pathPattern: "/exfiltrate" },
      { method: "POST" as const },
    ]) {
      await expect(
        updatePolicyRule(SCOPE, "app-1", input),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    // Row untouched.
    expect((store.rules[0] as RuleRow).hostPattern).toBe(HOST);
  });

  it("still allows non-endpoint edits on an app rule", async () => {
    seedAppRule();
    await updatePolicyRule(SCOPE, "app-1", { enabled: false });
    expect((store.rules[0] as RuleRow).enabled).toBe(false);
  });

  it("still allows endpoint edits on a custom rule", async () => {
    seedAppRule();
    await updatePolicyRule(SCOPE, "custom-1", { hostPattern: "api.other.com" });
    expect((store.rules[1] as RuleRow).hostPattern).toBe("api.other.com");
  });
});
