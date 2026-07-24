import { beforeEach, describe, expect, it, vi } from "vitest";

// Layer-2 authoring guard for the unified policy engine: a NON-DEFAULT rule must
// name at least one target. An empty target list would match NOTHING at the
// gateway (fail-closed — see the evaluator), so it is never a valid authored
// rule. The service rejects it with 422 on both create and update; OMITTING
// `targets` on update (the editor's locked-rule preserve) stays allowed. The db /
// providers are mocked only as far as the guard's reach.

const gate = vi.hoisted(() => ({ assertAllowed: vi.fn(async () => {}) }));

const state = vi.hoisted(() => ({
  // The rule `updatePolicyRule` fetches (findFirst, fenced to isDefault:false).
  existing: null as unknown,
}));

// A RuleRow the DTO mapper can read (identities/targets empty → []). Its shape is
// incidental — every test asserts the guard's control flow, not the row's data.
const ruleRow = vi.hoisted(() => (overrides: Record<string, unknown> = {}) => ({
  id: "r1",
  scope: "project",
  status: "draft",
  generation: 0,
  priority: 1,
  enabled: true,
  isDefault: false,
  source: "custom",
  name: "Rule",
  description: null,
  action: "block",
  rateLimit: null,
  rateLimitWindow: null,
  requireApproval: false,
  conditions: null,
  identities: [],
  targets: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
}));

vi.mock("../providers", () => ({
  getRuleActionGate: () => gate,
  // The default (permissive) validator: no optional validateTargets.
  getPolicyValidator: () => ({ validate: async () => {} }),
}));

vi.mock("@onecli/db", () => {
  const policyRuleV2 = {
    findFirst: async () => state.existing,
    aggregate: async () => ({ _max: { priority: 0 } }),
    create: async () => ruleRow(),
    update: async () => ruleRow(),
  };
  const tx = {
    // createPolicyRule takes the per-scope advisory lock inside its tx.
    $executeRaw: async () => 0,
    policyRuleIdentity: { deleteMany: async () => ({}) },
    policyRuleTarget: { deleteMany: async () => ({}) },
    policyRuleV2,
  };
  return {
    Prisma: { JsonNull: "JsonNull", PrismaClientKnownRequestError: class {} },
    db: {
      policyRuleV2,
      $transaction: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    },
  };
});

const { createPolicyRule, updatePolicyRule } = await import("./policy-service");

const SCOPE = { projectId: "p1" };
const USER = "user-1";
// A network target reaches no db in `assertTargetsValid` (no owned id to fence),
// so it isolates the guard without a connection/secret ownership mock.
const NETWORK_TARGET = {
  kind: "network" as const,
  hostPattern: "api.example.com",
};

beforeEach(() => {
  state.existing = ruleRow();
  gate.assertAllowed.mockClear();
});

describe("createPolicyRule requires at least one target (Layer 2)", () => {
  it("rejects an empty targets array with 422", async () => {
    await expect(
      createPolicyRule(
        SCOPE,
        { name: "R", action: "block", targets: [] },
        USER,
      ),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("rejects omitted targets with 422", async () => {
    await expect(
      createPolicyRule(SCOPE, { name: "R", action: "block" }, USER),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("accepts a rule that names a target (control)", async () => {
    await expect(
      createPolicyRule(
        SCOPE,
        { name: "R", action: "block", targets: [NETWORK_TARGET] },
        USER,
      ),
    ).resolves.toMatchObject({ id: "r1" });
  });
});

describe("updatePolicyRule rejects clearing a rule's targets (Layer 2)", () => {
  it("rejects a provided empty targets array with 422", async () => {
    await expect(
      updatePolicyRule(SCOPE, "r1", { targets: [] }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("allows an update that omits targets (locked-rule preserve)", async () => {
    await expect(
      updatePolicyRule(SCOPE, "r1", { name: "Renamed" }),
    ).resolves.toMatchObject({ id: "r1" });
  });
});
