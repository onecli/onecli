import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@onecli/db";

/**
 * The `SandboxLifecycleHooks` seam, as the shared claim sees it. Without a
 * registered hook (every self-host) the start arm must be byte-for-byte the
 * query it was before the seam: no extra predicate, the full limit. With
 * one, the hook's fragment lands in exactly the place the seam promises.
 */

const captured = vi.hoisted(() => ({ queries: [] as Prisma.Sql[] }));
const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(async () => 0),
  runner: { findUnique: vi.fn(async () => null) },
}));

vi.mock("@onecli/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@onecli/db")>();
  return {
    ...actual,
    db: {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});
vi.mock("../lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/env")>()),
  IS_CLOUD: false,
  LOG_LEVEL: "silent",
}));

const { claimDueWork } = await import("./due-work");
const { initSandboxLifecycleHooks } =
  await import("../providers/hooks/sandbox-lifecycle-hooks");

/** The start arm's query is the first `$queryRaw` of the claim. */
const startArm = (): Prisma.Sql => {
  const first = captured.queries[0];
  if (!first) throw new Error("the start arm never ran");
  return first;
};

beforeEach(() => {
  captured.queries = [];
  tx.$queryRaw.mockReset();
  tx.$queryRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      // The tagged-template form, composed the way Prisma composes it, so
      // nested `Prisma.sql` fragments inline into one statement.
      const sql = Prisma.sql(strings, ...values);
      captured.queries.push(sql);
      // Every arm answers "nothing due"; the eviction count answers 0.
      return sql.sql.includes("count(*)::int AS held") ? [{ held: 0 }] : [];
    },
  );
  initSandboxLifecycleHooks({});
});

describe("claimDueWork without lifecycle hooks", () => {
  it("renders the start arm with no extra predicate and the whole limit", async () => {
    const items = await claimDueWork("runner-1", 7);
    expect(items).toEqual([]);
    const arm = startArm();
    expect(arm.sql).not.toContain("sandbox_home_growth_operations");
    expect(arm.sql).not.toContain("active_home_growth_operation_id");
    // The hook slot renders as nothing: the runner-id predicate flows
    // straight into the next clause, exactly as the base query reads.
    expect(arm.sql.replace(/\s+/g, " ")).toContain(
      "WHERE s.runner_id = ? AND ( s.status = 'unprovisioned'",
    );
    expect(arm.values).toContain(7);
    // The base's start arm, pinned: a change to the shared query is a
    // deliberate edit here, never a hook leaking through.
    expect(arm.sql.replace(/\s+/g, " ").trim()).toMatchSnapshot();
  });
});

describe("claimDueWork with lifecycle hooks", () => {
  it("ANDs the hook's hold into the start arm, with the limit untouched", async () => {
    const hold = Prisma.sql`AND s.held = false`;
    initSandboxLifecycleHooks({ startHold: () => hold });
    const items = await claimDueWork("runner-1", 7);
    expect(items).toEqual([]);
    const arm = startArm();
    expect(arm.sql.replace(/\s+/g, " ")).toContain(
      "WHERE s.runner_id = ? AND s.held = false AND ( s.status = 'unprovisioned'",
    );
    expect(arm.values).toContain(7);
  });
});
