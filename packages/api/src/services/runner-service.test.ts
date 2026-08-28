import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Registration is the runner plane's front door: it is the ONE place a token
 * that has never been seen can become a credential, so its refusal arms are
 * security-critical. The availability cache is here too — it sits in front of
 * an unauthenticated endpoint.
 */

const ANCHOR = "rnr_the-instance-anchor-token";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
}));

vi.hoisted(() => {
  process.env.RUNNER_TOKEN = "rnr_the-instance-anchor-token";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

vi.mock("@onecli/db", () => ({
  // `sql` builds the keep-awake fragment listRunners' held-awake read embeds;
  // the mocked `$queryRaw` below answers it, so the fragment is never
  // interpreted — it only needs to be constructible.
  Prisma: { sql: () => ({}) },
  db: {
    runner: {
      findUnique: mocks.findUnique,
      create: mocks.create,
      update: mocks.update,
      count: mocks.count,
      findFirst: mocks.findFirst,
      findMany: mocks.findMany,
    },
    $queryRaw: async () => [],
  },
}));

const {
  registerRunner,
  getRunnerAvailability,
  resetRunnerAvailabilityCache,
  listRunners,
} = await import("./runner-service");

const CAPABILITIES = {
  maxSandboxes: 4,
  backend: "docker",
  homeDurability: "resident" as const,
};

const register = (token: string) =>
  registerRunner({ token, name: "laptop", capabilities: CAPABILITIES });

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.findUnique.mockResolvedValue(null);
  mocks.create.mockResolvedValue({ id: "r-new" });
  mocks.update.mockResolvedValue({});
  mocks.count.mockResolvedValue(0);
  mocks.findFirst.mockResolvedValue(null);
  mocks.findMany.mockResolvedValue([]);
  resetRunnerAvailabilityCache();
});

describe("registerRunner", () => {
  it("creates a runner for the instance's anchor token", async () => {
    expect(await register(ANCHOR)).toEqual({ ok: true, runnerId: "r-new" });
    expect(mocks.create).toHaveBeenCalled();
  });

  it("REFUSES a token that is neither known nor the anchor", async () => {
    expect(await register("rnr_attacker-supplied")).toEqual({ ok: false });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses a token that merely PREFIXES the anchor", async () => {
    expect(await register(ANCHOR.slice(0, -1))).toEqual({ ok: false });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses a token that extends the anchor", async () => {
    expect(await register(`${ANCHOR}extra`)).toEqual({ ok: false });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses an empty token even though the anchor is set", async () => {
    expect(await register("")).toEqual({ ok: false });
  });

  it("re-registers an already-known runner without minting a new row", async () => {
    mocks.findUnique.mockResolvedValue({ id: "r-existing" });

    expect(await register("rnr_some-other-known-token")).toEqual({
      ok: true,
      runnerId: "r-existing",
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "r-existing" } }),
    );
  });
});

describe("registerRunner with NO anchor configured (cloud's posture)", () => {
  it("refuses every unknown token, so nothing can register", async () => {
    vi.resetModules();
    process.env.RUNNER_TOKEN = "";
    const service = await import("./runner-service");

    const result = await service.registerRunner({
      token: "rnr_anything",
      name: "x",
      capabilities: CAPABILITIES,
    });

    expect(result).toEqual({ ok: false });
    expect(mocks.create).not.toHaveBeenCalled();
    process.env.RUNNER_TOKEN = ANCHOR;
    vi.resetModules();
  });
});

describe("availability", () => {
  it("reports nothing registered on a fresh deployment", async () => {
    expect(await getRunnerAvailability()).toEqual({
      registered: false,
      online: false,
    });
  });

  it("reports registered-but-offline when a runner exists with a stale heartbeat", async () => {
    mocks.count.mockResolvedValueOnce(1);
    mocks.findFirst.mockResolvedValueOnce(null);

    expect(await getRunnerAvailability()).toEqual({
      registered: true,
      online: false,
    });
  });

  it("states the online runner's home durability — the honest loss window (step 3)", async () => {
    mocks.count.mockResolvedValueOnce(1);
    mocks.findFirst.mockResolvedValueOnce({
      capabilities: {
        ...CAPABILITIES,
        backend: "cloud",
        homeDurability: "snapshot",
      },
    });

    expect(await getRunnerAvailability()).toEqual({
      registered: true,
      online: true,
      homeDurability: "snapshot",
    });
  });

  it("omits durability when the capabilities blob predates the field — absence, never a default", async () => {
    mocks.count.mockResolvedValueOnce(1);
    mocks.findFirst.mockResolvedValueOnce({
      capabilities: { maxSandboxes: 4, backend: "docker" },
    });

    expect(await getRunnerAvailability()).toEqual({
      registered: true,
      online: true,
    });
  });

  it("serves repeat reads from cache — the endpoint is unauthenticated", async () => {
    await getRunnerAvailability();
    await getRunnerAvailability();
    await getRunnerAvailability();

    // One count (+ one findFirst) for the first call, none for the rest.
    expect(mocks.count).toHaveBeenCalledTimes(1);
    expect(mocks.findFirst).toHaveBeenCalledTimes(1);
  });

  it("re-reads after the cache is cleared", async () => {
    await getRunnerAvailability();
    resetRunnerAvailabilityCache();
    await getRunnerAvailability();

    expect(mocks.count).toHaveBeenCalledTimes(2);
  });
});

describe("listRunners", () => {
  it("derives online from heartbeat age, and never leaks the token", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "r-1",
        name: "fresh",
        lastSeenAt: new Date(),
        capabilities: CAPABILITIES,
        _count: { sandboxes: 2 },
      },
      {
        id: "r-2",
        name: "stale",
        lastSeenAt: new Date(Date.now() - 60 * 60 * 1000),
        capabilities: CAPABILITIES,
        _count: { sandboxes: 0 },
      },
      {
        id: "r-3",
        name: "never",
        lastSeenAt: null,
        capabilities: null,
        _count: { sandboxes: 0 },
      },
    ]);

    const runners = await listRunners();

    expect(runners.map((r) => r.online)).toEqual([true, false, false]);
    expect(runners[0]?.sandboxCount).toBe(2);
    // The operator's held-awake view: count (none here) beside the ceiling —
    // derived max(1, maxSandboxes − 1), floored for unparseable capabilities.
    expect(runners[0]?.heldAwakeCount).toBe(0);
    expect(runners[0]?.heldAwakeCeiling).toBe(3);
    expect(runners[2]?.heldAwakeCeiling).toBe(1);
    // The typed §3.9 read: declared class, null for an unparseable blob.
    expect(runners[0]?.homeDurability).toBe("resident");
    expect(runners[2]?.homeDurability).toBeNull();
    expect(JSON.stringify(runners)).not.toContain("rnr_");
    // The select must not even fetch the token column.
    const select = mocks.findMany.mock.calls[0]?.[0]?.select as
      | Record<string, unknown>
      | undefined;
    expect(select?.token).toBeUndefined();
  });
});
