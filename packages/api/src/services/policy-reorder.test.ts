import { beforeEach, describe, expect, it, vi } from "vitest";

// The server half of manual ordering: `reorderPolicyRules` must (a) take the
// per-scope advisory lock BEFORE reading, (b) fence its read to the caller's
// scope (a foreign — e.g. another org's/project's — rule id can never pass the
// membership check: cross-scope isolation at the QUERY level), (c) reject any
// non-permutation (missing / duplicate / foreign ids) with 409 CONFLICT, and
// (d) write dense 1-based priorities in the given order. A concurrent lockless
// delete surfaces as Prisma P2025 mid-write → the same 409. The db is mocked at
// the boundary; the assertions pin the service's control flow + issued writes.

const gate = vi.hoisted(() => ({ assertAllowed: vi.fn(async () => {}) }));

const state = vi.hoisted(() => ({
  /** Ids the SCOPED draft read returns (the caller's own rules only). */
  draftIds: [] as string[],
  /** The where clause the in-tx findMany was issued with (the fence). */
  lastWhere: null as unknown,
  /** Call sequence — proves the lock precedes the read. */
  calls: [] as string[],
  /** Priority writes issued, in order. */
  writes: [] as { id: string; priority: number }[],
  /** When set, the update for this id throws P2025 (concurrent delete). */
  deletedMidway: null as string | null,
}));

const FakeKnownRequestError = vi.hoisted(
  () =>
    class FakeKnownRequestError extends Error {
      code = "";
    },
);

const dtoRow = vi.hoisted(() => (id: string, priority: number) => ({
  id,
  scope: "project",
  status: "draft",
  generation: 0,
  priority,
  enabled: true,
  isDefault: false,
  logicalId: `l-${id}`,
  source: "custom",
  name: `Rule ${id}`,
  description: null,
  action: "block",
  rateLimit: null,
  rateLimitWindow: null,
  requireApproval: false,
  conditions: null,
  identities: [],
  targets: [],
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
}));

vi.mock("../providers", () => ({
  getRuleActionGate: () => gate,
}));

vi.mock("@onecli/db", () => {
  const tx = {
    $executeRaw: async () => {
      state.calls.push("lock");
      return 0;
    },
    policyRuleV2: {
      findMany: async ({ where }: { where: unknown }) => {
        state.calls.push("read");
        state.lastWhere = where;
        return state.draftIds.map((id) => ({ id }));
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { priority: number };
      }) => {
        if (state.deletedMidway === where.id) {
          const err = new FakeKnownRequestError("row gone");
          err.code = "P2025";
          throw err;
        }
        state.writes.push({ id: where.id, priority: data.priority });
        return {};
      },
    },
  };
  return {
    Prisma: {
      JsonNull: "JsonNull",
      PrismaClientKnownRequestError: FakeKnownRequestError,
    },
    db: {
      // The post-write re-read (`listPolicyRules`) — served in written order.
      policyRuleV2: {
        findMany: async () => state.writes.map((w, i) => dtoRow(w.id, i + 1)),
      },
      $transaction: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    },
  };
});

const { reorderPolicyRules } = await import("./policy-service");

const SCOPE = { projectId: "p1" };

beforeEach(() => {
  state.draftIds = ["a", "b", "c"];
  state.lastWhere = null;
  state.calls = [];
  state.writes = [];
  state.deletedMidway = null;
});

describe("reorderPolicyRules", () => {
  it("writes dense 1-based priorities in the given order, lock before read", async () => {
    const rules = await reorderPolicyRules(SCOPE, ["c", "a", "b"]);

    expect(state.calls).toEqual(["lock", "read"]);
    expect(state.writes).toEqual([
      { id: "c", priority: 1 },
      { id: "a", priority: 2 },
      { id: "b", priority: 3 },
    ]);
    expect(rules.map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("fences the draft read to the caller's scope", async () => {
    await reorderPolicyRules(SCOPE, ["a", "b", "c"]);

    expect(state.lastWhere).toMatchObject({
      scope: "project",
      projectId: "p1",
      status: "draft",
      isDefault: false,
    });
  });

  it("409s on a foreign id — another scope's rule can never be named", async () => {
    await expect(
      reorderPolicyRules(SCOPE, ["a", "b", "other-orgs-rule"]),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state.writes).toEqual([]);
  });

  it("409s when an id is missing (stale subset)", async () => {
    await expect(reorderPolicyRules(SCOPE, ["a", "b"])).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(state.writes).toEqual([]);
  });

  it("409s on a duplicated id even at the right length", async () => {
    await expect(
      reorderPolicyRules(SCOPE, ["a", "b", "b"]),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state.writes).toEqual([]);
  });

  it("maps a mid-write P2025 (concurrent lockless delete) to 409", async () => {
    state.deletedMidway = "b";
    await expect(
      reorderPolicyRules(SCOPE, ["c", "a", "b"]),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
