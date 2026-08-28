import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * The dispatch seam on REAL PostgreSQL (§3.17). These laws are not visible in
 * a mock: `FOR UPDATE SKIP LOCKED` claiming under concurrency, the runner
 * fence (runner B must never claim runner A's sandbox — the planted negative
 * control), stale-claim recovery after a runner dies mid-start, and the idle
 * window that parks a running sandbox.
 *
 * Env-gated like the other proof suites; see pg-proof.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type DueWork = typeof import("./due-work");
type Placement = typeof import("./placement");
type Sandboxes = typeof import("./sandbox-service");

let db: Db;
let dueWork: DueWork;
let placement: Placement;
let sandboxes: Sandboxes;

const P = "dw-";
const ORG = `${P}org`;
const WORKSPACE = `${P}proj`;
const RUNNER_A = `${P}runner-a`;
const RUNNER_B = `${P}runner-b`;

const CAPABILITIES = {
  maxSandboxes: 4,
  backend: "docker",
  homeDurability: "resident",
};

const reset = async () => {
  await db.sandbox.deleteMany({
    where: {
      OR: [
        { id: { startsWith: P } },
        { runnerId: { in: [RUNNER_A, RUNNER_B] } },
      ],
    },
  });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: { startsWith: P } } });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

const seedAgent = async (suffix: string) => {
  const agent = await db.agent.create({
    data: {
      workspaceId: WORKSPACE,
      name: `agent ${suffix}`,
      identifier: `${P}${suffix}`,
      accessToken: `aoc_${P}${suffix}`,
      kind: "hosted",
      harness: "jcode",
    },
    select: { id: true },
  });
  return agent.id;
};

const seedSandbox = async (
  id: string,
  agentId: string,
  runnerId: string,
  data: {
    status: string;
    updatedAt?: Date;
    lastActiveAt?: Date;
    containerRef?: string;
  },
) => {
  await db.sandbox.create({
    data: {
      id: `${P}${id}`,
      agentId,
      runnerId,
      status: data.status,
      // Steady state: boot sync complete (applied == desired's default of 1).
      // The sync arm's own dueness is proven in home-sync.pg.test.ts;
      // here it would leak home.sync items into every other arm's claim.
      homeAppliedGeneration: 1,
      ...(data.lastActiveAt && { lastActiveAt: data.lastActiveAt }),
      ...(data.containerRef && { containerRef: data.containerRef }),
    },
  });
  // `updatedAt` is @updatedAt, so it can only be forced through raw SQL.
  if (data.updatedAt) {
    await db.$executeRaw`UPDATE sandboxes SET updated_at = ${data.updatedAt} WHERE id = ${`${P}${id}`}`;
  }
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  // Both seams read their windows from env at module load.
  process.env.SANDBOX_IDLE_STOP_SECONDS = "600";
  process.env.RUNNER_ONLINE_THRESHOLD_SECONDS = "90";

  ({ db } = await import("@onecli/db"));
  dueWork = await import("./due-work");
  placement = await import("./placement");
  sandboxes = await import("./sandbox-service");

  await reset();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "Due Work Workspace", organizationId: ORG },
  });
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  // By runner as well as by id prefix: placement picks ANY online runner, so a
  // hosted agent created by another suite can land a uuid-id sandbox on ours.
  // Leaving one behind would make these claim counts depend on suite order.
  await db.sandbox.deleteMany({
    where: {
      OR: [
        { id: { startsWith: P } },
        { runnerId: { in: [RUNNER_A, RUNNER_B] } },
      ],
    },
  });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: { startsWith: P } } });
  // Created OFFLINE (`lastSeenAt` null) on purpose. Claiming is fenced by
  // runner id, not liveness, so these tests don't need a heartbeat — and an
  // offline runner is invisible to `pickRunnerForSandbox`, which stops a
  // concurrently-running suite's hosted-agent create from landing an extra
  // sandbox on ours mid-test. The placement block below opts back in.
  await db.runner.createMany({
    data: [
      {
        id: RUNNER_A,
        name: "runner a",
        token: `rnr_${P}a`,
        capabilities: CAPABILITIES,
      },
      {
        id: RUNNER_B,
        name: "runner b",
        token: `rnr_${P}b`,
        capabilities: CAPABILITIES,
      },
    ],
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.$disconnect();
});

describe.skipIf(!PROOF_URL)("claimDueWork over real PostgreSQL", () => {
  it("claims an unprovisioned sandbox and flips it to starting", async () => {
    const agentId = await seedAgent("start-1");
    await seedSandbox("sb-1", agentId, RUNNER_A, { status: "unprovisioned" });

    const claimed = await dueWork.claimDueWork(RUNNER_A, 5);

    expect(claimed).toEqual([
      { kind: "start", sandboxId: `${P}sb-1`, agentId },
    ]);
    const row = await db.sandbox.findUnique({ where: { id: `${P}sb-1` } });
    expect(row?.status).toBe("starting");
  });

  it("does not re-claim a sandbox already claimed (the SKIP LOCKED effect)", async () => {
    const agentId = await seedAgent("start-2");
    await seedSandbox("sb-2", agentId, RUNNER_A, { status: "unprovisioned" });

    const first = await dueWork.claimDueWork(RUNNER_A, 5);
    const second = await dueWork.claimDueWork(RUNNER_A, 5);

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it("hands one sandbox to exactly one of two concurrent pollers", async () => {
    const agentId = await seedAgent("race");
    await seedSandbox("sb-race", agentId, RUNNER_A, {
      status: "unprovisioned",
    });

    const [a, b] = await Promise.all([
      dueWork.claimDueWork(RUNNER_A, 5),
      dueWork.claimDueWork(RUNNER_A, 5),
    ]);

    expect(a.length + b.length).toBe(1);
  });

  it("NEVER claims another runner's sandbox (planted cross-runner control)", async () => {
    const mine = await seedAgent("mine");
    const theirs = await seedAgent("theirs");
    await seedSandbox("sb-mine", mine, RUNNER_A, { status: "unprovisioned" });
    await seedSandbox("sb-theirs", theirs, RUNNER_B, {
      status: "unprovisioned",
    });

    const claimed = await dueWork.claimDueWork(RUNNER_A, 10);

    expect(claimed.map((c) => c.sandboxId)).toEqual([`${P}sb-mine`]);
    const foreign = await db.sandbox.findUnique({
      where: { id: `${P}sb-theirs` },
    });
    expect(foreign?.status).toBe("unprovisioned");
  });

  it("reclaims a stale claim left by a runner that died mid-start", async () => {
    const agentId = await seedAgent("stale");
    await seedSandbox("sb-stale", agentId, RUNNER_A, {
      status: "starting",
      updatedAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    const claimed = await dueWork.claimDueWork(RUNNER_A, 5);
    expect(claimed.map((c) => c.sandboxId)).toEqual([`${P}sb-stale`]);
  });

  it("leaves a FRESH claim alone (a runner mid-start is not stale)", async () => {
    const agentId = await seedAgent("fresh");
    await seedSandbox("sb-fresh", agentId, RUNNER_A, { status: "starting" });

    expect(await dueWork.claimDueWork(RUNNER_A, 5)).toEqual([]);
  });

  it("claims a stop for a sandbox idle past its window", async () => {
    const agentId = await seedAgent("idle");
    await seedSandbox("sb-idle", agentId, RUNNER_A, {
      status: "running",
      lastActiveAt: new Date(Date.now() - 60 * 60 * 1000),
      containerRef: "cont-idle",
    });

    const claimed = await dueWork.claimDueWork(RUNNER_A, 5);

    expect(claimed).toEqual([
      { kind: "stop", sandboxId: `${P}sb-idle`, containerRef: "cont-idle" },
    ]);
    const row = await db.sandbox.findUnique({ where: { id: `${P}sb-idle` } });
    expect(row?.status).toBe("stopping");
  });

  it("leaves a recently-active sandbox running", async () => {
    const agentId = await seedAgent("busy");
    await seedSandbox("sb-busy", agentId, RUNNER_A, {
      status: "running",
      lastActiveAt: new Date(),
    });

    expect(await dueWork.claimDueWork(RUNNER_A, 5)).toEqual([]);
  });

  it("never returns more than the limit", async () => {
    for (const suffix of ["l1", "l2", "l3"]) {
      const agentId = await seedAgent(suffix);
      await seedSandbox(`sb-${suffix}`, agentId, RUNNER_A, {
        status: "unprovisioned",
      });
    }

    const claimed = await dueWork.claimDueWork(RUNNER_A, 2);
    expect(claimed).toHaveLength(2);
  });

  it("never returns more than the limit on the STOP path either", async () => {
    for (const suffix of ["s1", "s2", "s3"]) {
      const agentId = await seedAgent(suffix);
      await seedSandbox(`sb-${suffix}`, agentId, RUNNER_A, {
        status: "running",
        lastActiveAt: new Date(Date.now() - 60 * 60 * 1000),
      });
    }

    const claimed = await dueWork.claimDueWork(RUNNER_A, 2);

    expect(claimed).toHaveLength(2);
    expect(claimed.every((item) => item.kind === "stop")).toBe(true);
  });

  it("fills the limit with starts FIRST, then stops", async () => {
    const startAgent = await seedAgent("mix-start");
    await seedSandbox("sb-mix-start", startAgent, RUNNER_A, {
      status: "unprovisioned",
    });
    const stopAgent = await seedAgent("mix-stop");
    await seedSandbox("sb-mix-stop", stopAgent, RUNNER_A, {
      status: "running",
      lastActiveAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const claimed = await dueWork.claimDueWork(RUNNER_A, 2);

    expect(claimed.map((item) => item.kind)).toEqual(["start", "stop"]);
  });

  it("releaseClaim puts a start back for the next poll", async () => {
    const agentId = await seedAgent("release");
    await seedSandbox("sb-release", agentId, RUNNER_A, {
      status: "unprovisioned",
    });

    await dueWork.claimDueWork(RUNNER_A, 5);
    await dueWork.releaseClaim(`${P}sb-release`, RUNNER_A);

    const claimed = await dueWork.claimDueWork(RUNNER_A, 5);
    expect(claimed.map((c) => c.sandboxId)).toEqual([`${P}sb-release`]);
  });

  it("releaseClaim is runner-fenced", async () => {
    const agentId = await seedAgent("release-fence");
    await seedSandbox("sb-rf", agentId, RUNNER_A, { status: "unprovisioned" });
    await dueWork.claimDueWork(RUNNER_A, 5);

    await dueWork.releaseClaim(`${P}sb-rf`, RUNNER_B);

    const row = await db.sandbox.findUnique({ where: { id: `${P}sb-rf` } });
    expect(row?.status).toBe("starting");
  });
});

describe.skipIf(!PROOF_URL)("the runner fence on event application", () => {
  it("applies an event from the owning runner", async () => {
    const agentId = await seedAgent("ev-own");
    await seedSandbox("sb-ev", agentId, RUNNER_A, { status: "starting" });

    await sandboxes.applyRunnerEvent(RUNNER_A, {
      kind: "sandbox.status",
      sandboxId: `${P}sb-ev`,
      status: "running",
      containerRef: "cont-ev",
    });

    const row = await db.sandbox.findUnique({ where: { id: `${P}sb-ev` } });
    expect(row?.status).toBe("running");
    expect(row?.containerRef).toBe("cont-ev");
    expect(row?.lastActiveAt).not.toBeNull();
  });

  it("IGNORES an event naming another runner's sandbox", async () => {
    const agentId = await seedAgent("ev-foreign");
    await seedSandbox("sb-foreign", agentId, RUNNER_A, { status: "starting" });

    await sandboxes.applyRunnerEvent(RUNNER_B, {
      kind: "sandbox.status",
      sandboxId: `${P}sb-foreign`,
      status: "failed",
      error: "spoofed",
    });

    const row = await db.sandbox.findUnique({
      where: { id: `${P}sb-foreign` },
    });
    expect(row?.status).toBe("starting");
  });

  it("supervisor.ready is the transition to running", async () => {
    const agentId = await seedAgent("ev-ready");
    await seedSandbox("sb-ready", agentId, RUNNER_A, { status: "starting" });

    await sandboxes.applyRunnerEvent(RUNNER_A, {
      kind: "supervisor.ready",
      sandboxId: `${P}sb-ready`,
    });

    const row = await db.sandbox.findUnique({ where: { id: `${P}sb-ready` } });
    expect(row?.status).toBe("running");
  });

  it("lists only the owning runner's sandboxes, with their statuses", async () => {
    const mine = await seedAgent("list-mine");
    const theirs = await seedAgent("list-theirs");
    await seedSandbox("sb-lm", mine, RUNNER_A, { status: "running" });
    await seedSandbox("sb-lt", theirs, RUNNER_B, { status: "running" });

    expect(await sandboxes.listRunnerSandboxes(RUNNER_A)).toEqual([
      { id: `${P}sb-lm`, status: "running" },
    ]);
  });

  it("respawn marks a live sandbox unprovisioned so the next poll restarts it", async () => {
    const agentId = await seedAgent("respawn");
    await seedSandbox("sb-respawn", agentId, RUNNER_A, {
      status: "running",
      lastActiveAt: new Date(),
    });

    await sandboxes.requestSandboxRespawn(agentId, WORKSPACE);

    const claimed = await dueWork.claimDueWork(RUNNER_A, 5);
    expect(claimed.map((c) => c.sandboxId)).toEqual([`${P}sb-respawn`]);
  });

  it("respawn is fenced to the workspace — planted cross-workspace control", async () => {
    // The function writes two tables (the sandbox, and its conversations'
    // in-flight turns), so an id arriving from anywhere unfenced would reach
    // across tenants. Fenced at the QUERY, and proved by an agent that really
    // exists in another workspace rather than by an id that matches nothing.
    const otherWorkspace = `${P}other-proj`;
    await db.workspace.upsert({
      where: { id: otherWorkspace },
      create: { id: otherWorkspace, name: otherWorkspace, organizationId: ORG },
      update: {},
    });
    const foreign = await db.agent.create({
      data: {
        workspaceId: otherWorkspace,
        name: "foreign",
        identifier: `${P}foreign`,
        accessToken: `aoc_${P}foreign`,
        kind: "hosted",
      },
      select: { id: true },
    });
    await seedSandbox("sb-foreign", foreign.id, RUNNER_A, {
      status: "running",
      lastActiveAt: new Date(),
    });

    // The right agent id, the WRONG workspace.
    await sandboxes.requestSandboxRespawn(foreign.id, WORKSPACE);

    const row = await db.sandbox.findUnique({
      where: { id: `${P}sb-foreign` },
    });
    expect(row?.status).toBe("running");

    // Positive control: with its own workspace it does move, so the assertion
    // above is about the fence and not about some unrelated no-op.
    await sandboxes.requestSandboxRespawn(foreign.id, otherWorkspace);
    expect(
      (await db.sandbox.findUnique({ where: { id: `${P}sb-foreign` } }))
        ?.status,
    ).toBe("unprovisioned");
  });

  it("respawn leaves a PARKED sandbox parked", async () => {
    // A stopped sandbox already composes its payload from current truth at its
    // next start, so respawning it fixes nothing and starts a container nobody
    // asked for. Sleeping is the default (§3.9): editing a credential must not
    // wake every agent that holds it.
    const agentId = await seedAgent("respawn-parked");
    await seedSandbox("sb-parked", agentId, RUNNER_A, { status: "stopped" });

    await sandboxes.requestSandboxRespawn(agentId, WORKSPACE);

    const row = await db.sandbox.findUnique({ where: { id: `${P}sb-parked` } });
    expect(row?.status).toBe("stopped");
    expect(await dueWork.claimDueWork(RUNNER_A, 5)).toEqual([]);
  });

  it("respawn fails the turns whose container it is about to destroy", async () => {
    // The respawn recreates the container, so the harness session behind an
    // in-flight turn is gone — the same fact `applyRunnerEvent` handles when a
    // sandbox goes down, reached by a different door. Left non-terminal, the
    // active-turn index blocks the conversation until the turn ceiling.
    const agentId = await seedAgent("respawn-turns");
    await seedSandbox("sb-turns", agentId, RUNNER_A, {
      status: "running",
      lastActiveAt: new Date(),
    });
    // Two conversations, because at most one turn per conversation may be
    // active — which is the very index a stranded turn would block.
    for (const suffix of ["a", "b"]) {
      await db.conversation.create({
        data: { id: `${P}cv-${suffix}`, agentId, source: "web" },
      });
    }
    await db.turn.create({
      data: {
        id: `${P}t-inflight`,
        conversationId: `${P}cv-a`,
        message: "in flight",
        status: "running",
      },
    });
    // A QUEUED turn must be untouched: it was never handed to anything, so it
    // is still perfectly deliverable once the new container is up — and waking
    // for exactly it is what the start arm's EXISTS clause is for.
    await db.turn.create({
      data: {
        id: `${P}t-queued`,
        conversationId: `${P}cv-b`,
        message: "queued",
        status: "queued",
      },
    });

    await sandboxes.requestSandboxRespawn(agentId, WORKSPACE);

    const inFlight = await db.turn.findUnique({
      where: { id: `${P}t-inflight` },
    });
    expect(inFlight?.status).toBe("failed");
    expect(inFlight?.finishedAt).not.toBeNull();
    expect(
      (await db.turn.findUnique({ where: { id: `${P}t-queued` } }))?.status,
    ).toBe("queued");
  });
});

describe.skipIf(!PROOF_URL)("placement over real PostgreSQL", () => {
  // Placement only ever considers ONLINE runners, so this block — and only
  // this block — heartbeats them. Every pick below is fenced to this file's
  // fixture runners: sibling suites heartbeat their own runners in the same
  // database, and an unfenced pick would be green or red by scheduling.
  const amongOurs = { candidateIds: [RUNNER_A, RUNNER_B] };

  beforeEach(async () => {
    if (!PROOF_URL) return;
    await db.runner.updateMany({
      where: { id: { in: [RUNNER_A, RUNNER_B] } },
      data: { lastSeenAt: new Date() },
    });
  });

  it("picks an online runner with spare capacity", async () => {
    expect([RUNNER_A, RUNNER_B]).toContain(
      await placement.pickRunnerForSandbox(amongOurs),
    );
  });

  it("skips a runner that is at capacity", async () => {
    await db.runner.update({
      where: { id: RUNNER_A },
      data: { capabilities: { ...CAPABILITIES, maxSandboxes: 1 } },
    });
    await db.runner.delete({ where: { id: RUNNER_B } });
    const agentId = await seedAgent("cap");
    await seedSandbox("sb-cap", agentId, RUNNER_A, { status: "running" });

    expect(await placement.pickRunnerForSandbox(amongOurs)).toBeNull();
  });

  it("skips a runner whose heartbeat went stale (offline)", async () => {
    await db.runner.updateMany({
      where: { id: { in: [RUNNER_A, RUNNER_B] } },
      data: { lastSeenAt: new Date(Date.now() - 10 * 60 * 1000) },
    });
    expect(await placement.pickRunnerForSandbox(amongOurs)).toBeNull();
  });

  it("prefers the least-loaded runner", async () => {
    const agentId = await seedAgent("load");
    await seedSandbox("sb-load", agentId, RUNNER_A, { status: "running" });

    expect(await placement.pickRunnerForSandbox(amongOurs)).toBe(RUNNER_B);
  });

  it("counts stopped sandboxes as free (they hold only a volume)", async () => {
    await db.runner.update({
      where: { id: RUNNER_A },
      data: { capabilities: { ...CAPABILITIES, maxSandboxes: 1 } },
    });
    await db.runner.delete({ where: { id: RUNNER_B } });
    const agentId = await seedAgent("stopped");
    await seedSandbox("sb-stopped", agentId, RUNNER_A, { status: "stopped" });

    expect(await placement.pickRunnerForSandbox(amongOurs)).toBe(RUNNER_A);
  });

  it("never leaves the candidate fence, even for a strictly better runner", async () => {
    // The committed negative control for the fence itself: an ONLINE,
    // zero-load runner outside the fence — strictly preferable to the
    // loaded fixture runners — must still lose, and an empty fence matches
    // nothing. Delete the id filter in pickRunnerForSandbox and both
    // assertions fail; without them the whole block's determinism guard
    // could silently regress.
    await db.runner.create({
      data: {
        id: `${P}runner-foreign`,
        name: "runner foreign",
        token: `rnr_${P}foreign`,
        capabilities: CAPABILITIES,
        lastSeenAt: new Date(),
      },
    });
    const a = await seedAgent("fence-a");
    const b = await seedAgent("fence-b");
    await seedSandbox("sb-fence-a", a, RUNNER_A, { status: "running" });
    await seedSandbox("sb-fence-b", b, RUNNER_B, { status: "running" });

    expect([RUNNER_A, RUNNER_B]).toContain(
      await placement.pickRunnerForSandbox(amongOurs),
    );
    expect(
      await placement.pickRunnerForSandbox({ candidateIds: [] }),
    ).toBeNull();
  });
});

describe.skipIf(!PROOF_URL)("wake priority (step 4)", () => {
  /** A stopped sandbox with one waiting turn — the start arm's wake shape. */
  const seedWakeCandidate = async (input: {
    suffix: string;
    updatedAt: Date;
    turnSource: string;
    turnCreatedAt?: Date;
  }) => {
    const agentId = await seedAgent(input.suffix);
    await seedSandbox(`sb-${input.suffix}`, agentId, RUNNER_A, {
      status: "stopped",
      updatedAt: input.updatedAt,
    });
    await db.conversation.create({
      data: { id: `${P}cv-${input.suffix}`, agentId, source: "web" },
    });
    await db.turn.create({
      data: {
        id: `${P}t-${input.suffix}`,
        conversationId: `${P}cv-${input.suffix}`,
        message: "wake me",
        status: "queued",
        source: input.turnSource,
        ...(input.turnCreatedAt && { createdAt: input.turnCreatedAt }),
      },
    });
    return agentId;
  };

  it("a person's wake outranks an older cron wake in the start arm", async () => {
    await seedWakeCandidate({
      suffix: "prio-cron",
      updatedAt: new Date(Date.now() - 10 * 60 * 1000),
      turnSource: "cron",
    });
    await seedWakeCandidate({
      suffix: "prio-web",
      updatedAt: new Date(Date.now() - 5 * 60 * 1000),
      turnSource: "web",
    });

    // Limit 1 makes the ORDER BY the admission policy — without the rank the
    // older-updated cron sandbox would claim first.
    const claimed = await dueWork.claimDueWork(RUNNER_A, 1);
    expect(claimed.map((c) => c.sandboxId)).toEqual([`${P}sb-prio-web`]);
  });

  it("positive control: with both wakes cron-born, the older sandbox claims first", async () => {
    // Same seeding as above with the web source flipped to cron — proving
    // the previous assertion holds BECAUSE of the source rank, not by luck
    // of updated_at ordering.
    await seedWakeCandidate({
      suffix: "ctl-old",
      updatedAt: new Date(Date.now() - 10 * 60 * 1000),
      turnSource: "cron",
    });
    await seedWakeCandidate({
      suffix: "ctl-new",
      updatedAt: new Date(Date.now() - 5 * 60 * 1000),
      turnSource: "cron",
    });

    const claimed = await dueWork.claimDueWork(RUNNER_A, 1);
    expect(claimed.map((c) => c.sandboxId)).toEqual([`${P}sb-ctl-old`]);
  });

  it("a background wake past the age cap ranks as user-visible (starvation bound)", async () => {
    // Aged cron on the YOUNGER-updated sandbox vs fresh cron on the older —
    // without the age cap the older sandbox would win; with it, the aged
    // turn's sandbox does.
    await seedWakeCandidate({
      suffix: "age-old",
      updatedAt: new Date(Date.now() - 10 * 60 * 1000),
      turnSource: "cron",
    });
    await seedWakeCandidate({
      suffix: "age-aged",
      updatedAt: new Date(Date.now() - 2 * 60 * 1000),
      turnSource: "cron",
      turnCreatedAt: new Date(
        Date.now() - (dueWork.WAKE_PRIORITY_AGE_SECONDS + 60) * 1000,
      ),
    });

    const claimed = await dueWork.claimDueWork(RUNNER_A, 1);
    expect(claimed.map((c) => c.sandboxId)).toEqual([`${P}sb-age-aged`]);
  });

  it("the turn arm dispatches a person's message ahead of older cron runs", async () => {
    // One RUNNING sandbox, six queued turns across six conversations: five
    // cron-born (oldest first) and one web-born YOUNGEST. The 5-turn budget
    // must include the web turn and exclude the newest cron turn.
    const agentId = await seedAgent("tprio");
    await seedSandbox("sb-tprio", agentId, RUNNER_A, {
      status: "running",
      lastActiveAt: new Date(),
    });
    for (let i = 0; i < 5; i++) {
      await db.conversation.create({
        data: { id: `${P}cv-tp-${i}`, agentId, source: "web" },
      });
      await db.turn.create({
        data: {
          id: `${P}t-tp-cron-${i}`,
          conversationId: `${P}cv-tp-${i}`,
          message: `cron ${i}`,
          status: "queued",
          source: "cron",
          // All UNDER the age cap — a cron turn past WAKE_PRIORITY_AGE_SECONDS
          // deliberately ranks user-visible and would defeat this proof.
          createdAt: new Date(Date.now() - (300 - i * 30) * 1000),
        },
      });
    }
    await db.conversation.create({
      data: { id: `${P}cv-tp-web`, agentId, source: "web" },
    });
    await db.turn.create({
      data: {
        id: `${P}t-tp-web`,
        conversationId: `${P}cv-tp-web`,
        message: "a person",
        status: "queued",
        source: "web",
        createdAt: new Date(Date.now() - 60 * 1000),
      },
    });

    const claimed = await dueWork.claimDueWork(RUNNER_A, 5);
    const turnIds = claimed.flatMap((c) =>
      c.kind === "turn" ? [c.turnId] : [],
    );
    expect(turnIds).toContain(`${P}t-tp-web`);
    // The newest cron turn is the one the budget squeezed out — the rank is
    // what made room, not a bigger limit.
    expect(turnIds).not.toContain(`${P}t-tp-cron-4`);
    expect(turnIds).toHaveLength(5);
  });
});

describe.skipIf(!PROOF_URL)("the failed-status guard (step 4)", () => {
  it("a delayed duplicate `failed` never knocks a RUNNING sandbox back", async () => {
    // Reports are fire-and-forget with retries: a reconcile's stale corpse
    // report can land after a successful re-start reached running. Unguarded
    // it would strand the live turns and park the queue.
    const agentId = await seedAgent("failguard");
    await seedSandbox("sb-failguard", agentId, RUNNER_A, {
      status: "running",
      lastActiveAt: new Date(),
      containerRef: "cont-live",
    });

    await sandboxes.applyRunnerEvent(RUNNER_A, {
      kind: "sandbox.status",
      sandboxId: `${P}sb-failguard`,
      status: "failed",
      error: "stale corpse report",
    });

    const row = await db.sandbox.findUnique({
      where: { id: `${P}sb-failguard` },
    });
    expect(row?.status).toBe("running");
  });

  it("positive control: `failed` still applies over `starting`", async () => {
    const agentId = await seedAgent("failctl");
    await seedSandbox("sb-failctl", agentId, RUNNER_A, { status: "starting" });

    await sandboxes.applyRunnerEvent(RUNNER_A, {
      kind: "sandbox.status",
      sandboxId: `${P}sb-failctl`,
      status: "failed",
      error: "boot crash",
    });

    expect(
      (await db.sandbox.findUnique({ where: { id: `${P}sb-failctl` } }))
        ?.status,
    ).toBe("failed");
  });
});
