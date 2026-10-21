import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * The AWAKE-TIME LEDGER on real PostgreSQL. What a mock cannot show: the
 * `container_ref` uniqueness that makes the open idempotent, the partial
 * unique that keeps one open row per sandbox, the sweep's three arms
 * (orphan close, abandoned close, unrecorded open), the rollup's cursor and
 * day attribution, and the usage reads' overlap arithmetic over rows that
 * straddle the window. The ledger is wired at the status writers, so the
 * last block drives `applyRunnerEvent`, a respawn and an agent delete
 * end-to-end and reads the rows back.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Ledger = typeof import("./runtime-ledger");
type Usage = typeof import("./runtime-usage-service");
type Sandboxes = typeof import("./sandbox-service");
type Agents = typeof import("./agent-service");

let db: Db;
let ledger: Ledger;
let usage: Usage;
let sandboxes: Sandboxes;
let agents: Agents;

const P = "rl-";
const ORG = `${P}org`;
const ORG_B = `${P}org-b`;
const WORKSPACE = `${P}ws`;
const WORKSPACE_B = `${P}ws-b`;
const RUNNER = `${P}runner`;

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);
/** The rollup's in-flight lag, in ms (see runtime-ledger.ts). */
const ROLLUP_LAG_MS = 30_000;

/** This suite owns both ledger tables in the proof database: other suites
 * write rows through the status writers and never read them back, and the
 * sweep is global, so their leftovers would skew every count here. */
const resetLedger = async () => {
  await db.$executeRaw`DELETE FROM sandbox_runtime_intervals`;
  await db.$executeRaw`DELETE FROM runtime_usage_daily`;
};

const reset = async () => {
  await resetLedger();
  await db.sandbox.deleteMany({ where: { id: { startsWith: P } } });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: RUNNER } });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

const seedAgent = async (suffix: string, workspaceId = WORKSPACE) => {
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `agent ${suffix}`,
      identifier: `${P}${suffix}`,
      accessToken: `aoc_${P}${suffix}`,
      kind: "hosted",
      harness: "fake",
    },
    select: { id: true },
  });
  return agent.id;
};

const seedSandbox = async (
  suffix: string,
  agentId: string,
  status: string,
  containerRef: string | null = null,
) => {
  await db.sandbox.create({
    data: {
      id: `${P}sb-${suffix}`,
      agentId,
      runnerId: RUNNER,
      status,
      containerRef,
      homeAppliedGeneration: 1,
    },
  });
  return `${P}sb-${suffix}`;
};

/** A ledger row planted directly (the past the sweep and reads work on). */
const plantInterval = async (
  agentId: string,
  containerRef: string,
  startedAt: Date,
  endedAt: Date | null,
  opts: {
    organizationId?: string;
    workspaceId?: string;
    sandboxId?: string;
  } = {},
) => {
  await db.sandboxRuntimeInterval.create({
    data: {
      organizationId: opts.organizationId ?? ORG,
      workspaceId: opts.workspaceId ?? WORKSPACE,
      agentId,
      sandboxId: opts.sandboxId ?? `${P}sb-planted`,
      containerRef: `${P}${containerRef}`,
      startedAt,
      endedAt,
      ...(endedAt && { endReason: "stopped" }),
    },
  });
};

const intervalsOf = (sandboxId: string) =>
  db.sandboxRuntimeInterval.findMany({
    where: { sandboxId },
    orderBy: { startedAt: "asc" },
    select: {
      containerRef: true,
      endedAt: true,
      endReason: true,
      organizationId: true,
      workspaceId: true,
      agentId: true,
    },
  });

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  ({ db } = await import("@onecli/db"));
  const { ensureEditionDefaults } = await import("../edition-defaults");
  ensureEditionDefaults();
  ledger = await import("./runtime-ledger");
  usage = await import("./runtime-usage-service");
  sandboxes = await import("./sandbox-service");
  agents = await import("./agent-service");
  await reset();
  await db.organization.createMany({
    data: [
      { id: ORG, name: ORG, slug: ORG },
      { id: ORG_B, name: ORG_B, slug: ORG_B },
    ],
  });
  await db.workspace.createMany({
    data: [
      { id: WORKSPACE, name: "ledger ws", organizationId: ORG },
      { id: WORKSPACE_B, name: "ledger ws b", organizationId: ORG_B },
    ],
  });
  await db.runner.create({
    data: {
      id: RUNNER,
      name: "ledger runner",
      token: `rnr_${P}`,
      capabilities: {
        maxSandboxes: 4,
        backend: "docker",
        homeDurability: "resident",
      },
    },
  });
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await resetLedger();
  await db.sandbox.deleteMany({ where: { id: { startsWith: P } } });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  ledger.resetRollupCursor();
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.$disconnect();
});

describe.skipIf(!PROOF_URL)("open / close", () => {
  it("opens one row per container ref, copies the org/workspace/agent ids, and a duplicate open is a no-op", async () => {
    const agentId = await seedAgent("open");
    const sb = await seedSandbox("open", agentId, "starting", `${P}c1`);

    await db.$transaction((tx) => ledger.openRuntimeInterval(tx, sb, `${P}c1`));
    // The runner's retry / a second copy's observation of the same start.
    await db.$transaction((tx) => ledger.openRuntimeInterval(tx, sb, `${P}c1`));

    const rows = await intervalsOf(sb);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      containerRef: `${P}c1`,
      endedAt: null,
      organizationId: ORG,
      workspaceId: WORKSPACE,
      agentId,
    });
  });

  it("a NEW container closes the previous open run as 'lost' before opening its own", async () => {
    const agentId = await seedAgent("open-new");
    const sb = await seedSandbox("open-new", agentId, "starting", `${P}c2`);
    await db.$transaction((tx) => ledger.openRuntimeInterval(tx, sb, `${P}c1`));
    // The stop report of c1 never landed; c2 starts.
    await db.$transaction((tx) => ledger.openRuntimeInterval(tx, sb, `${P}c2`));

    const rows = await intervalsOf(sb);
    expect(rows.map((r) => [r.containerRef, r.endReason])).toEqual([
      [`${P}c1`, "lost"],
      [`${P}c2`, null],
    ]);
    expect(rows[0]?.endedAt).not.toBeNull();
  });

  it("close is idempotent and keyed on the open row only", async () => {
    const agentId = await seedAgent("close");
    const sb = await seedSandbox("close", agentId, "running", `${P}c1`);
    await db.$transaction((tx) => ledger.openRuntimeInterval(tx, sb, `${P}c1`));

    await db.$transaction((tx) => ledger.closeRuntimeInterval(tx, sb, "idle"));
    const [first] = await intervalsOf(sb);
    // A late duplicate stop report, with a different reason: inert.
    await db.$transaction((tx) =>
      ledger.closeRuntimeInterval(tx, sb, "failed"),
    );
    const [again] = await intervalsOf(sb);

    expect(first?.endReason).toBe("idle");
    expect(again).toEqual(first);
  });

  it("a sandbox with no agent any more opens nothing (the delete race)", async () => {
    // No sandbox row at all: the join finds nothing, nothing is inserted.
    await db.$transaction((tx) =>
      ledger.openRuntimeInterval(tx, `${P}sb-ghost`, `${P}c-ghost`),
    );
    expect(
      await db.sandboxRuntimeInterval.count({
        where: { containerRef: `${P}c-ghost` },
      }),
    ).toBe(0);
  });

  it("the partial unique index refuses a second OPEN row for one sandbox by any other door", async () => {
    const agentId = await seedAgent("unique");
    const sb = await seedSandbox("unique", agentId, "running", `${P}c1`);
    await plantInterval(agentId, "u1", ago(HOUR), null, { sandboxId: sb });
    await expect(
      plantInterval(agentId, "u2", ago(HOUR), null, { sandboxId: sb }),
    ).rejects.toThrow(/one_open_per_sandbox|Unique constraint/);
  });
});

describe.skipIf(!PROOF_URL)("the sweep", () => {
  it("closes an open run whose sandbox is parked, at the sandbox's own status change", async () => {
    const agentId = await seedAgent("orphan");
    const sb = await seedSandbox("orphan", agentId, "stopped", `${P}c1`);
    const parkedAt = ago(2 * HOUR);
    await db.$executeRaw`UPDATE sandboxes SET updated_at = ${parkedAt} WHERE id = ${sb}`;
    await plantInterval(agentId, "o1", ago(5 * HOUR), null, { sandboxId: sb });

    const result = await ledger.sweepRuntimeLedger();

    expect(result.orphansClosed).toBe(1);
    const [row] = await intervalsOf(sb);
    expect(row?.endReason).toBe("lost");
    expect(row?.endedAt?.getTime()).toBe(parkedAt.getTime());
  });

  it("leaves a run open while its sandbox is starting, running OR stopping", async () => {
    for (const status of ["starting", "running", "stopping"]) {
      const agentId = await seedAgent(`live-${status}`);
      const sb = await seedSandbox(
        `live-${status}`,
        agentId,
        status,
        `${P}c-${status}`,
      );
      await plantInterval(agentId, `l-${status}`, ago(HOUR), null, {
        sandboxId: sb,
      });
    }
    const result = await ledger.sweepRuntimeLedger();
    expect(result.orphansClosed).toBe(0);
    expect(
      await db.sandboxRuntimeInterval.count({ where: { endedAt: null } }),
    ).toBe(3);
  });

  it("closes a run whose sandbox row is GONE as 'deleted'", async () => {
    const agentId = await seedAgent("gone");
    await plantInterval(agentId, "g1", ago(HOUR), null, {
      sandboxId: `${P}sb-vanished`,
    });
    const result = await ledger.sweepRuntimeLedger();
    expect(result.orphansClosed).toBe(1);
    const row = await db.sandboxRuntimeInterval.findUniqueOrThrow({
      where: { containerRef: `${P}g1` },
      select: { endReason: true, endedAt: true },
    });
    expect(row.endReason).toBe("deleted");
    expect(row.endedAt).not.toBeNull();
  });

  it("opens a run for a RUNNING sandbox nothing recorded (the lost start report), from its ready stamp", async () => {
    const agentId = await seedAgent("unrecorded");
    const sb = await seedSandbox(
      "unrecorded",
      agentId,
      "running",
      `${P}c-unrec`,
    );
    const readyAt = ago(HOUR);
    await db.$executeRaw`UPDATE sandboxes SET updated_at = ${readyAt} WHERE id = ${sb}`;

    const result = await ledger.sweepRuntimeLedger();

    expect(result.unrecordedOpened).toBe(1);
    const [row] = await intervalsOf(sb);
    expect(row).toMatchObject({ containerRef: `${P}c-unrec`, endedAt: null });
    // A second pass does not open another.
    expect((await ledger.sweepRuntimeLedger()).unrecordedOpened).toBe(0);
  });

  it("the rollup folds closed rows per UTC day, straddles midnight, advances its cursor, and re-folds idempotently", async () => {
    const agentId = await seedAgent("rollup");
    // A 4h run straddling a UTC midnight two days ago: 1h on day D, 3h on D+1.
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    midnight.setUTCDate(midnight.getUTCDate() - 1);
    const start = new Date(midnight.getTime() - HOUR);
    const end = new Date(midnight.getTime() + 3 * HOUR);
    await plantInterval(agentId, "r1", start, end);

    const first = await ledger.sweepRuntimeLedger();
    expect(first.daysRolledUp).toBe(2);
    const days = await db.runtimeUsageDaily.findMany({
      where: { organizationId: ORG, agentId },
      orderBy: { day: "asc" },
      select: { day: true, awakeSeconds: true },
    });
    expect(days.map((d) => Number(d.awakeSeconds))).toEqual([3600, 3 * 3600]);
    expect(days[1]?.day.toISOString().slice(0, 10)).toBe(
      midnight.toISOString().slice(0, 10),
    );

    // Nothing new closed: the cursor moved, so nothing is re-folded.
    expect((await ledger.sweepRuntimeLedger()).daysRolledUp).toBe(0);

    // A process restart re-seeds the cursor from the rollup's own write:
    // re-folding the same rows recomputes the same totals.
    ledger.resetRollupCursor();
    await ledger.sweepRuntimeLedger();
    const again = await db.runtimeUsageDaily.findMany({
      where: { organizationId: ORG, agentId },
      orderBy: { day: "asc" },
      select: { awakeSeconds: true },
    });
    expect(again.map((d) => Number(d.awakeSeconds))).toEqual([3600, 3 * 3600]);

    // A second run that STARTED on D+1 and closed inside the last pass's
    // window (its `ended_at` sits before the cursor the pass advanced to:
    // a transaction that committed late). The in-process cursor has moved
    // past it, so only a RE-SEED (a restart, which backs off two lags) folds
    // it: D+1 is touched again and RECOMPUTED (not incremented) to the sum
    // of both rows, and today gets the new row's share.
    const closedAt = ago(1.5 * ROLLUP_LAG_MS);
    await plantInterval(
      agentId,
      "r2",
      new Date(midnight.getTime() + 5 * HOUR),
      closedAt,
    );
    expect((await ledger.sweepRuntimeLedger()).daysRolledUp).toBe(0);
    ledger.resetRollupCursor();
    await ledger.sweepRuntimeLedger();
    const after = await db.runtimeUsageDaily.findMany({
      where: { organizationId: ORG, agentId },
      orderBy: { day: "asc" },
      select: { awakeSeconds: true },
    });
    const todayMidnight = new Date(midnight.getTime() + 24 * HOUR);
    // Postgres truncates the sum to a bigint; the planted ms edge may round
    // either way, so today's share is checked to the second.
    const todayShare = (closedAt.getTime() - todayMidnight.getTime()) / 1000;
    const totals = after.map((d) => Number(d.awakeSeconds));
    expect(totals.slice(0, 2)).toEqual([3600, 3 * 3600 + 19 * 3600]);
    expect(Math.abs((totals[2] ?? 0) - todayShare)).toBeLessThanOrEqual(1);
  });

  it("the rollup leaves a row closed inside the lag for the next pass (the in-flight window)", async () => {
    const agentId = await seedAgent("lag");
    await plantInterval(agentId, "lag1", ago(HOUR), ago(5_000));
    const result = await ledger.sweepRuntimeLedger();
    expect(result.daysRolledUp).toBe(0);
    expect(
      await db.runtimeUsageDaily.count({ where: { organizationId: ORG } }),
    ).toBe(0);
  });
});

describe.skipIf(!PROOF_URL)("the usage reads", () => {
  /** Today's UTC midnight, and the one N days before. */
  const midnight = (daysAgo = 0) => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - daysAgo);
    return d;
  };
  /** Seconds since today's UTC midnight, read at call time. */
  const sinceMidnight = () => (Date.now() - midnight().getTime()) / 1000;
  /** A window of whole days: [daysAgo days before today, now). */
  const lastDays = (daysAgo: number) => ({
    from: midnight(daysAgo),
    to: new Date(),
  });
  /** A rollup row planted directly (what the sweep would have written). */
  const plantDay = async (agentId: string, day: Date, awakeSeconds: number) =>
    db.runtimeUsageDaily.create({
      data: { organizationId: ORG, agentId, day, awakeSeconds },
    });

  it("past days come from the rollup, today and open runs from the ledger, and the two never double count", async () => {
    const agentId = await seedAgent("read");
    // Two past days in the rollup.
    await plantDay(agentId, midnight(2), 3600);
    await plantDay(agentId, midnight(1), 1800);
    // A closed run that straddled last midnight: yesterday's share is in
    // the rollup (planted above as if swept); only today's share may be
    // read from the ledger.
    await plantInterval(
      agentId,
      "s1",
      new Date(midnight().getTime() - HOUR),
      new Date(midnight().getTime() + 10 * 60_000),
    );
    // A run that closed today, fully inside it: 15 min from the ledger.
    await plantInterval(
      agentId,
      "s2",
      new Date(midnight().getTime() + 20 * 60_000),
      new Date(midnight().getTime() + 35 * 60_000),
    );
    // Still open since 2h before midnight: 2h of yesterday (not in the
    // rollup yet: it has not closed) and all of today, from the ledger.
    await plantInterval(
      agentId,
      "s3",
      new Date(midnight().getTime() - 2 * HOUR),
      null,
    );

    const before = sinceMidnight();
    const result = await usage.getAgentRuntimeUsage(
      WORKSPACE,
      ORG,
      agentId,
      lastDays(3),
    );
    const after = sinceMidnight();
    // The open run's today share is read at the database's `now()`, which
    // sits between the two local readings; everything else is exact.
    const fixed = 3600 + 1800 + 600 + 900 + 2 * 3600;
    expect(result.awakeSeconds).toBeGreaterThanOrEqual(
      Math.floor(fixed + before) - 1,
    );
    expect(result.awakeSeconds).toBeLessThanOrEqual(
      Math.ceil(fixed + after) + 1,
    );
    expect(result.running).toBe(true);
  });

  it("a window that ends before today reads the rollup alone, plus an open run's share of it", async () => {
    const agentId = await seedAgent("read-past");
    await plantDay(agentId, midnight(3), 100);
    await plantDay(agentId, midnight(2), 200);
    await plantDay(agentId, midnight(1), 400); // outside: window ends 2 days ago
    // A closed run today: outside the window entirely.
    await plantInterval(
      agentId,
      "p1",
      new Date(midnight().getTime() + HOUR),
      new Date(midnight().getTime() + 2 * HOUR),
    );
    // An open run since 4 days ago: its share of the window's 2 days.
    await plantInterval(agentId, "p2", midnight(4), null);

    const result = await usage.getAgentRuntimeUsage(WORKSPACE, ORG, agentId, {
      from: midnight(3),
      to: midnight(1),
    });
    expect(result.awakeSeconds).toBe(100 + 200 + 2 * 86_400);
    expect(result.running).toBe(true);
  });

  it("the agent read is fenced: a foreign workspace's agent is a 404, and a foreign org's rows never sum in", async () => {
    const mine = await seedAgent("fence-mine");
    const theirs = await seedAgent("fence-theirs", WORKSPACE_B);
    await plantInterval(theirs, "t1", ago(HOUR), null, {
      organizationId: ORG_B,
      workspaceId: WORKSPACE_B,
    });
    await expect(
      usage.getAgentRuntimeUsage(WORKSPACE, ORG, theirs, lastDays(1)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Rows mislabelled with my agent id but their org (cannot happen by
    // the open's join; planted as the negative control) are excluded by
    // the reads' own org filter, in the ledger and the rollup alike.
    await plantInterval(mine, "t2", ago(HOUR), null, {
      organizationId: ORG_B,
      workspaceId: WORKSPACE_B,
      sandboxId: `${P}sb-x`,
    });
    await db.runtimeUsageDaily.create({
      data: {
        organizationId: ORG_B,
        agentId: mine,
        day: midnight(1),
        awakeSeconds: 999,
      },
    });
    const result = await usage.getAgentRuntimeUsage(
      WORKSPACE,
      ORG,
      mine,
      lastDays(2),
    );
    expect(result.awakeSeconds).toBe(0);
    expect(result.running).toBe(false);
  });

  it("the org read sums rollup and ledger per agent, most first, omits zero rows, and never crosses orgs", async () => {
    const a = await seedAgent("org-a");
    const b = await seedAgent("org-b");
    const c = await seedAgent("org-c");
    const foreign = await seedAgent("org-foreign", WORKSPACE_B);
    await plantDay(a, midnight(1), 3600);
    await plantDay(b, midnight(1), 3600);
    // b also ran today: 1h closed.
    await plantInterval(
      b,
      "ob",
      new Date(midnight().getTime() + HOUR),
      new Date(midnight().getTime() + 2 * HOUR),
      { sandboxId: `${P}sb-b` },
    );
    // c ran, but before the window.
    await plantDay(c, midnight(5), 7200);
    await plantInterval(foreign, "of", ago(2 * HOUR), null, {
      organizationId: ORG_B,
      workspaceId: WORKSPACE_B,
      sandboxId: `${P}sb-f`,
    });

    const result = await usage.getOrgRuntimeUsage(ORG, lastDays(2));
    expect(result.agents).toEqual([
      { agentId: b, awakeSeconds: 7200 },
      { agentId: a, awakeSeconds: 3600 },
    ]);
    expect(result.awakeSeconds).toBe(10_800);
  });

  it("the window schema reads UTC dates, clamps `to` to now, and refuses an inverted window", async () => {
    const { usageWindowSchema } = await import("../validations/usage");
    const today = new Date().toISOString().slice(0, 10);
    const parsed = usageWindowSchema.parse({ from: "2026-01-01", to: today });
    expect(parsed.from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(parsed.to.getTime()).toBeLessThanOrEqual(Date.now());
    expect(parsed.to.getTime()).toBeGreaterThan(Date.now() - 5_000);
    const past = usageWindowSchema.parse({
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(past.to.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(usageWindowSchema.parse({}).from.getTime()).toBe(0);
    expect(
      usageWindowSchema.safeParse({ from: today, to: "2026-01-01" }).success,
    ).toBe(false);
    expect(usageWindowSchema.safeParse({ from: "not-a-date" }).success).toBe(
      false,
    );
  });
});

describe.skipIf(!PROOF_URL)("wired at the status writers", () => {
  const event = (
    sandboxId: string,
    status: "starting" | "stopped" | "failed",
    containerRef?: string,
  ) =>
    ({
      kind: "sandbox.status",
      sandboxId,
      status,
      ...(containerRef && { containerRef }),
    }) as const;

  it("a start report opens, a stop report closes with the stop claim's reason", async () => {
    const agentId = await seedAgent("wire-stop");
    const sb = await seedSandbox("wire-stop", agentId, "starting");
    await sandboxes.applyRunnerEvent(RUNNER, event(sb, "starting", `${P}w1`));
    expect((await intervalsOf(sb))[0]).toMatchObject({
      containerRef: `${P}w1`,
      endedAt: null,
    });

    // The ready report, then the idle park's stop claim, then the stop.
    await db.sandbox.update({
      where: { id: sb },
      data: { status: "running" },
    });
    await db.sandbox.update({
      where: { id: sb },
      data: { status: "stopping", stopReason: "idle" },
    });
    await sandboxes.applyRunnerEvent(RUNNER, event(sb, "stopped"));

    const [row] = await intervalsOf(sb);
    expect(row?.endReason).toBe("idle");
    expect(row?.endedAt).not.toBeNull();
  });

  it("a STALE stop report (the sandbox already restarted) closes nothing", async () => {
    const agentId = await seedAgent("wire-stale");
    const sb = await seedSandbox("wire-stale", agentId, "starting");
    await sandboxes.applyRunnerEvent(RUNNER, event(sb, "starting", `${P}w2`));
    await db.sandbox.update({ where: { id: sb }, data: { status: "running" } });
    // Reconcile re-observes the OLD container dead, after the new start.
    await sandboxes.applyRunnerEvent(RUNNER, {
      kind: "sandbox.status",
      sandboxId: sb,
      status: "stopped",
      observedContainerRef: `${P}w-old`,
    });
    expect((await intervalsOf(sb))[0]?.endedAt).toBeNull();
  });

  it("a failed start closes as 'failed'", async () => {
    const agentId = await seedAgent("wire-fail");
    const sb = await seedSandbox("wire-fail", agentId, "starting");
    await sandboxes.applyRunnerEvent(RUNNER, event(sb, "starting", `${P}w3`));
    await sandboxes.applyRunnerEvent(RUNNER, event(sb, "failed"));
    expect((await intervalsOf(sb))[0]?.endReason).toBe("failed");
  });

  it("a respawn closes the run as 'respawn' in the same transaction as the flip", async () => {
    const agentId = await seedAgent("wire-respawn");
    const sb = await seedSandbox("wire-respawn", agentId, "running", `${P}w4`);
    await db.$transaction((tx) => ledger.openRuntimeInterval(tx, sb, `${P}w4`));
    await sandboxes.requestSandboxRespawn(agentId, WORKSPACE);
    expect((await intervalsOf(sb))[0]?.endReason).toBe("respawn");
    expect(
      (await db.sandbox.findUniqueOrThrow({ where: { id: sb } })).status,
    ).toBe("unprovisioned");
  });

  it("deleting the agent closes the run as 'deleted' and the row OUTLIVES the agent", async () => {
    const agentId = await seedAgent("wire-delete");
    const sb = await seedSandbox("wire-delete", agentId, "running", `${P}w5`);
    await db.$transaction((tx) => ledger.openRuntimeInterval(tx, sb, `${P}w5`));
    await agents.deleteAgent(WORKSPACE, agentId);
    expect(await db.agent.count({ where: { id: agentId } })).toBe(0);
    const row = await db.sandboxRuntimeInterval.findUniqueOrThrow({
      where: { containerRef: `${P}w5` },
      select: { endReason: true, agentId: true },
    });
    expect(row).toEqual({ endReason: "deleted", agentId });
  });
});
