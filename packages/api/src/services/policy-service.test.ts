import { beforeEach, describe, expect, it, vi } from "vitest";

// The backfill write (`backfillPublishScope`) is the only DB-touching path under
// test; everything else it uses (policyScope, jsonInput, identityCreate,
// backfillTargetCreate) is pure. So we mock just the transaction + the two
// policyRuleV2 methods it calls and assert control flow + the emitted row shape.

const state = vi.hoisted(() => ({
  publishedCount: 0,
  creates: [] as { data: Record<string, unknown> }[],
  deleteManyCalls: 0,
  deleteManyWheres: [] as unknown[],
  // For assertSessionPolicyValid: the project→org resolution, the (already
  // scope-fenced) connection rows the mock returns, the `where` each fence query
  // is called with, and the validator invocations.
  projectOrg: "org-1" as string | null,
  connections: [] as { provider: string; metadata: unknown }[],
  connectionWheres: [] as unknown[],
  validatorCalls: [] as {
    organizationId: string;
    provider: string;
    policy: Record<string, unknown>;
  }[],
}));

vi.mock("@onecli/db", () => ({
  Prisma: { JsonNull: "JsonNull" },
  db: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        // lockScope's advisory lock
        $executeRaw: async () => 0,
        policyRuleV2: {
          count: async () => state.publishedCount,
          create: async ({ data }: { data: Record<string, unknown> }) => {
            state.creates.push({ data });
            return { id: `id-${state.creates.length}` };
          },
          deleteMany: async ({ where }: { where: unknown }) => {
            state.deleteManyCalls += 1;
            state.deleteManyWheres.push(where);
            return { count: 0 };
          },
        },
      };
      return fn(tx);
    },
    project: {
      findUnique: async () =>
        state.projectOrg == null ? null : { organizationId: state.projectOrg },
    },
    appConnection: {
      findMany: async ({ where }: { where: unknown }) => {
        state.connectionWheres.push(where);
        return state.connections;
      },
    },
  },
}));

const { backfillPublishScope, assertSessionPolicyValid } =
  await import("./policy-service");
const { initPolicyValidator } = await import("../providers");

const networkRule = {
  priority: 0,
  isDefault: false,
  source: "custom" as const,
  name: "block google",
  action: "block" as const,
  rateLimit: null,
  rateLimitWindow: null,
  requireApproval: false,
  conditions: null,
  identities: [{ type: "agent" as const, id: "agent-1" }],
  targets: [
    {
      kind: "network" as const,
      hostPattern: "google.com",
      pathPattern: null,
      // A lowercase method the strict API enum would reject — must survive verbatim.
      method: "get",
    },
  ],
};

describe("backfillPublishScope", () => {
  beforeEach(() => {
    state.publishedCount = 0;
    state.creates = [];
    state.deleteManyCalls = 0;
    state.deleteManyWheres = [];
  });

  it("is idempotent — skips a scope that already has a published generation", async () => {
    state.publishedCount = 3;
    const result = await backfillPublishScope({ organizationId: "org-1" }, [
      networkRule,
    ]);
    expect(result).toEqual({ skipped: true, generation: null, ruleCount: 0 });
    expect(state.creates).toHaveLength(0);
    // The default path never deletes — it only skips.
    expect(state.deleteManyCalls).toBe(0);
  });

  it("replace: discards the published scope and re-writes fresh (the heal path)", async () => {
    // A scope that ALREADY has a published generation — the default path would
    // skip; replace must delete it and re-materialize instead (fixing a scope
    // frozen from an earlier catalog-less run).
    state.publishedCount = 5;
    const result = await backfillPublishScope(
      { organizationId: "org-1" },
      [networkRule],
      { replace: true },
    );
    expect(state.deleteManyCalls).toBe(1); // stale v2 discarded
    // The delete is fenced to EXACTLY this scope (the `scope` discriminator keeps
    // an org replace from ever matching a project/other-org row) — the single
    // highest-risk property of the heal path.
    expect(state.deleteManyWheres[0]).toEqual({
      scope: "organization",
      organizationId: "org-1",
    });
    expect(result).toEqual({ skipped: false, generation: 1, ruleCount: 1 });
    expect(state.creates).toHaveLength(2); // fresh draft gen 0 + published gen 1
  });

  it("replace on a project scope fences the delete to that project", async () => {
    state.publishedCount = 2;
    await backfillPublishScope({ projectId: "proj-1" }, [networkRule], {
      replace: true,
    });
    expect(state.deleteManyWheres[0]).toEqual({
      scope: "project",
      projectId: "proj-1",
    });
  });

  it("replace with no rules still discards the stale scope (generation null)", async () => {
    // A scope whose old model is now empty must be CLEARED, not left stale.
    state.publishedCount = 4;
    const result = await backfillPublishScope({ organizationId: "org-1" }, [], {
      replace: true,
    });
    expect(state.deleteManyCalls).toBe(1);
    expect(state.creates).toHaveLength(0);
    expect(result).toEqual({ skipped: false, generation: null, ruleCount: 0 });
  });

  it("writes each rule as draft gen 0 + published gen 1 (the gateway reads published)", async () => {
    const result = await backfillPublishScope({ organizationId: "org-1" }, [
      networkRule,
    ]);
    expect(result).toEqual({ skipped: false, generation: 1, ruleCount: 1 });
    expect(state.creates).toHaveLength(2);

    const [draft, published] = state.creates.map((c) => c.data);
    expect(draft).toMatchObject({ status: "draft", generation: 0 });
    expect(published).toMatchObject({ status: "published", generation: 1 });

    // Scope, priority, action all carried onto both rows.
    for (const row of [draft, published]) {
      expect(row).toMatchObject({
        scope: "organization",
        organizationId: "org-1",
        priority: 0,
        isDefault: false,
        action: "block",
        name: "block google",
      });
    }
  });

  it("preserves the verbatim method string (not the strict API enum)", async () => {
    await backfillPublishScope({ organizationId: "org-1" }, [networkRule]);
    const published = state.creates[1]?.data as
      | { targets: { create: { method: string | null }[] } }
      | undefined;
    expect(published?.targets.create[0]?.method).toBe("get");
  });

  it("maps a project scope + preserves the org Default Rule flag", async () => {
    const result = await backfillPublishScope({ projectId: "proj-1" }, [
      { ...networkRule, isDefault: true, identities: [], targets: [] },
    ]);
    expect(result.generation).toBe(1);
    const published = state.creates[1]?.data;
    expect(published).toMatchObject({
      scope: "project",
      projectId: "proj-1",
      isDefault: true,
    });
  });
});

describe("assertSessionPolicyValid", () => {
  const connTarget = (connectionId: string) => ({
    kind: "connection" as const,
    connectionId,
  });

  beforeEach(() => {
    state.projectOrg = "org-1";
    state.connections = [];
    state.connectionWheres = [];
    state.validatorCalls = [];
    // A spy validator via the provider seam — the default (OSS) validator is a
    // no-op, so a spy is how we observe the entitlement/shape gate firing.
    initPolicyValidator({
      validate: async (organizationId, provider, _metadata, policy) => {
        state.validatorCalls.push({ organizationId, provider, policy });
      },
    });
  });

  it("is a no-op for behavioral (array) conditions", async () => {
    await assertSessionPolicyValid(
      { scope: "project", projectId: "p1" },
      [connTarget("c1")],
      [{ target: "body", operator: "contains", value: "x" }],
      "allow",
    );
    expect(state.validatorCalls).toHaveLength(0);
    expect(state.connectionWheres).toHaveLength(0);
  });

  it("is a no-op for null conditions", async () => {
    await assertSessionPolicyValid(
      { scope: "project", projectId: "p1" },
      [connTarget("c1")],
      null,
      "allow",
    );
    expect(state.validatorCalls).toHaveLength(0);
  });

  it("rejects a session policy on a BLOCK (a block injects nothing)", async () => {
    await expect(
      assertSessionPolicyValid(
        { scope: "project", projectId: "p1" },
        [connTarget("c1")],
        { repositories: ["a/b"] },
        "block",
      ),
    ).rejects.toThrow(/only to Allow/);
    expect(state.validatorCalls).toHaveLength(0);
  });

  it("rejects a session policy with NO connection target (the update-path gate)", async () => {
    // The create Zod refine catches this, but an update has no refine — the
    // service throw is the ONLY thing stopping a two-PATCH entitlement bypass.
    await expect(
      assertSessionPolicyValid(
        { scope: "project", projectId: "p1" },
        [{ kind: "network", hostPattern: "x" }],
        { repositories: ["a/b"] },
        "allow",
      ),
    ).rejects.toThrow(/requires a connection target/);
    expect(state.validatorCalls).toHaveLength(0);
  });

  it("validates fenced to the PROJECT scope; dedups ids; a foreign id is dropped (cross-org)", async () => {
    // Two distinct ids requested, only ONE in-scope row returned by the fence →
    // exactly one validate() call. A foreign id resolves to nothing and is never
    // validated — the query-level cross-org fence.
    state.connections = [{ provider: "github", metadata: { repos: ["a/b"] } }];
    await assertSessionPolicyValid(
      { scope: "project", projectId: "p1" },
      [connTarget("c1"), connTarget("c1"), connTarget("c2")],
      { repositories: ["a/b"] },
      "allow",
    );
    expect(state.connectionWheres[0]).toEqual({
      id: { in: ["c1", "c2"] }, // deduped
      projectId: "p1", // fenced to the acting project
    });
    expect(state.validatorCalls).toHaveLength(1);
    expect(state.validatorCalls[0]).toMatchObject({
      organizationId: "org-1",
      provider: "github",
      policy: { repositories: ["a/b"] },
    });
  });

  it("fences an ORG-scope session policy to the org's own connections", async () => {
    state.connections = [{ provider: "dropbox", metadata: {} }];
    await assertSessionPolicyValid(
      { scope: "organization", organizationId: "org-9" },
      [connTarget("c1")],
      { folders: ["/x"] },
      "allow",
    );
    expect(state.connectionWheres[0]).toEqual({
      id: { in: ["c1"] },
      organizationId: "org-9",
      scope: "organization",
    });
    expect(state.validatorCalls[0]).toMatchObject({ organizationId: "org-9" });
  });

  it("throws when the project's organization can't be resolved", async () => {
    state.projectOrg = null;
    await expect(
      assertSessionPolicyValid(
        { scope: "project", projectId: "ghost" },
        [connTarget("c1")],
        { repositories: ["a/b"] },
        "allow",
      ),
    ).rejects.toThrow(/organization/i);
  });
});
