import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RunnerEvent } from "@onecli/agent-protocol";
import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * Background processes + watches on REAL PostgreSQL (step 10). What only pg
 * can prove: the container-ref fencing (a stale row off a dead container
 * never reads as live), the state-machine transition guards, the §3.9
 * keep-awake predicate with its ref term, the three sweeps, the one-shot
 * fire claim under concurrency, and the coherence CHECKs — each with a
 * planted negative.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Processes = typeof import("./sandbox-process-service");
type DueWork = typeof import("./due-work");
type WatchFire = typeof import("./watch-fire-service");
type Sandboxes = typeof import("./sandbox-service");
type TurnService = typeof import("./turn-service");

let db: Db;
let processes: Processes;
let dueWork: DueWork;
let watchFire: WatchFire;
let sandboxes: Sandboxes;
let turnService: TurnService;

const P = "pw-";
const ORG = `${P}org`;
const WORKSPACE = `${P}proj`;
const RUNNER_A = `${P}runner-a`;
const RUNNER_B = `${P}runner-b`;
const USER = `${P}user`;

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SANDBOX_IDLE_STOP_SECONDS = "600";

  ({ db } = await import("@onecli/db"));
  processes = await import("./sandbox-process-service");
  dueWork = await import("./due-work");
  watchFire = await import("./watch-fire-service");
  sandboxes = await import("./sandbox-service");
  turnService = await import("./turn-service");

  await resetAll();
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await resetAll();
});

const resetAll = async () => {
  await db.processWatch.deleteMany({
    where: {
      process: { sandbox: { agent: { identifier: { startsWith: P } } } },
    },
  });
  await db.sandboxProcess.deleteMany({
    where: { sandbox: { agent: { identifier: { startsWith: P } } } },
  });
  await db.turn.deleteMany({
    where: { conversation: { agent: { identifier: { startsWith: P } } } },
  });
  await db.conversation.deleteMany({
    where: { agent: { identifier: { startsWith: P } } },
  });
  await db.sandbox.deleteMany({
    where: { OR: [{ id: { startsWith: P } }, { runnerId: { startsWith: P } }] },
  });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: { startsWith: P } } });
  await db.user.deleteMany({ where: { id: USER } });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

beforeEach(async () => {
  if (!PROOF_URL) return;
  await resetAll();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "P", organizationId: ORG },
  });
  await db.user.create({
    data: { id: USER, email: `${P}user@example.com`, externalAuthId: `${P}a` },
  });
  await db.runner.createMany({
    data: [
      { id: RUNNER_A, name: "a", token: `rnr_${P}a` },
      { id: RUNNER_B, name: "b", token: `rnr_${P}b` },
    ],
  });
});

const seedAgent = async (suffix: string) => {
  const agent = await db.agent.create({
    data: {
      workspaceId: WORKSPACE,
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
  status = "running",
  overrides: {
    containerRef?: string;
    runnerId?: string;
    lastActiveAt?: Date;
  } = {},
) => {
  await db.sandbox.create({
    data: {
      id: `${P}sb-${suffix}`,
      agentId,
      runnerId: overrides.runnerId ?? RUNNER_A,
      status,
      containerRef: overrides.containerRef ?? `cont-${suffix}`,
      lastActiveAt: overrides.lastActiveAt ?? new Date(),
      homeAppliedGeneration: 1,
    },
  });
  return `${P}sb-${suffix}`;
};

const stateEvent = (
  sandboxId: string,
  containerRef: string,
  process: Record<string, unknown>,
): Extract<RunnerEvent, { kind: "process.state" }> =>
  ({
    kind: "process.state",
    sandboxId,
    containerRef,
    process: {
      ref: "p-1",
      command: "sleep 30",
      status: "running",
      startedAt: new Date().toISOString(),
      watches: [],
      ...process,
    },
  }) as Extract<RunnerEvent, { kind: "process.state" }>;

/** Grant the agent a model key so a fired watch's run turn is born queued
 * (not door-1 failed) — the settle/delivery path needs a real run to finish.
 * Mirrors the cron.pg helper. */
const grantLlmKey = async (agentId: string, suffix: string) => {
  const secret = await db.secret.create({
    data: {
      scope: "workspace",
      workspaceId: WORKSPACE,
      name: `${P}${suffix}`,
      type: "anthropic",
      encryptedValue: "enc",
      hostPattern: "api.anthropic.com",
      metadata: { authMode: "api-key" },
    },
    select: { id: true },
  });
  await db.policyRuleV2.create({
    data: {
      scope: "workspace",
      workspaceId: WORKSPACE,
      status: "published",
      generation: 1,
      priority: 10,
      isDefault: false,
      enabled: true,
      source: "equipment",
      logicalId: `${P}${suffix}`,
      name: `${P}${suffix}`,
      action: "allow",
      requireApproval: false,
      identities: { create: [{ agentId }] },
      targets: { create: [{ kind: "secret", secretId: secret.id }] },
    },
  });
};

describe.skipIf(!PROOF_URL)("fencing", () => {
  it("a foreign runner's frame is inert", async () => {
    const agentId = await seedAgent("foreign-rnr");
    const sb = await seedSandbox("foreign-rnr", agentId, "running", {
      containerRef: "cont-x",
    });
    await processes.applyProcessState(
      RUNNER_B,
      stateEvent(sb, "cont-x", { ref: "p-1" }),
    );
    expect(await db.sandboxProcess.count({ where: { sandboxId: sb } })).toBe(0);
  });

  it("heals a null container ref, then a MISMATCHED ref refuses the whole frame", async () => {
    const agentId = await seedAgent("anchor");
    // Null ref → healed to the event's, and the process lands.
    await db.sandbox.create({
      data: {
        id: `${P}sb-anchor`,
        agentId,
        runnerId: RUNNER_A,
        status: "running",
        containerRef: null,
        lastActiveAt: new Date(),
        homeAppliedGeneration: 1,
      },
    });
    await processes.applyProcessState(
      RUNNER_A,
      stateEvent(`${P}sb-anchor`, "cont-real", { ref: "p-1" }),
    );
    const healed = await db.sandbox.findUnique({
      where: { id: `${P}sb-anchor` },
      select: { containerRef: true },
    });
    expect(healed?.containerRef).toBe("cont-real");
    expect(
      await db.sandboxProcess.count({ where: { sandboxId: `${P}sb-anchor` } }),
    ).toBe(1);

    // A later frame from a DIFFERENT container is refused whole.
    await processes.applyProcessState(
      RUNNER_A,
      stateEvent(`${P}sb-anchor`, "cont-stale", { ref: "p-2" }),
    );
    expect(
      await db.sandboxProcess.count({ where: { sandboxId: `${P}sb-anchor` } }),
    ).toBe(1);
  });

  it("a forged (sandboxId, ref) lands as THAT sandbox's own row, never another tenant's", async () => {
    const a = await seedAgent("tenant-a");
    const b = await seedAgent("tenant-b");
    const sbA = await seedSandbox("tenant-a", a, "running", {
      containerRef: "ca",
    });
    const sbB = await seedSandbox("tenant-b", b, "running", {
      containerRef: "cb",
    });
    await processes.applyProcessState(
      RUNNER_A,
      stateEvent(sbA, "ca", { ref: "shared" }),
    );
    await processes.applyProcessState(
      RUNNER_A,
      stateEvent(sbB, "cb", { ref: "shared" }),
    );
    // Same ref, two sandboxes, two distinct rows — no cross-tenant collision.
    expect(await db.sandboxProcess.count({ where: { sandboxId: sbA } })).toBe(
      1,
    );
    expect(await db.sandboxProcess.count({ where: { sandboxId: sbB } })).toBe(
      1,
    );
  });

  it("verifies arm-time context once: forged conversation dropped, real one anchored, never re-anchored", async () => {
    const agentId = await seedAgent("prov");
    const other = await seedAgent("prov-other");
    const sb = await seedSandbox("prov", agentId, "running", {
      containerRef: "c",
    });
    // A conversation this agent OWNS, with a user turn behind it.
    const own = await db.conversation.create({
      data: { agentId, source: "web" },
      select: { id: true },
    });
    const ownTurn = await db.turn.create({
      data: {
        conversationId: own.id,
        source: "web",
        userId: USER,
        message: "hi",
      },
      select: { id: true },
    });
    // A conversation owned by a DIFFERENT agent — the forged claim.
    const foreign = await db.conversation.create({
      data: { agentId: other, source: "web" },
      select: { id: true },
    });

    // Forged: the row still lands, but provenance is DROPPED — never anchored
    // to another agent's conversation. MUTATION-PROOF: drop the `agentId`
    // fence in resolveVerifiedContext and originConversationId becomes foreign.
    await processes.applyProcessState(
      RUNNER_A,
      stateEvent(sb, "c", { ref: "forged", conversationId: foreign.id }),
    );
    const forgedRow = await db.sandboxProcess.findUniqueOrThrow({
      where: { sandboxId_ref: { sandboxId: sb, ref: "forged" } },
      select: { originConversationId: true, createdByUserId: true },
    });
    expect(forgedRow.originConversationId).toBeNull();
    expect(forgedRow.createdByUserId).toBeNull();

    // Real: anchored to the agent's own conversation and its user.
    await processes.applyProcessState(
      RUNNER_A,
      stateEvent(sb, "c", {
        ref: "real",
        conversationId: own.id,
        turnId: ownTurn.id,
      }),
    );
    const realRow = await db.sandboxProcess.findUniqueOrThrow({
      where: { sandboxId_ref: { sandboxId: sb, ref: "real" } },
      select: { originConversationId: true, createdByUserId: true },
    });
    expect(realRow.originConversationId).toBe(own.id);
    expect(realRow.createdByUserId).toBe(USER);

    // Write-once: a later frame claiming a DIFFERENT (valid) conversation must
    // NOT re-anchor. MUTATION-PROOF: make updateProcess write provenance and
    // this flips to own2.
    const own2 = await db.conversation.create({
      data: { agentId, source: "web" },
      select: { id: true },
    });
    await processes.applyProcessState(
      RUNNER_A,
      stateEvent(sb, "c", {
        ref: "real",
        conversationId: own2.id,
        tail: "more",
      }),
    );
    expect(
      (
        await db.sandboxProcess.findUniqueOrThrow({
          where: { sandboxId_ref: { sandboxId: sb, ref: "real" } },
          select: { originConversationId: true },
        })
      ).originConversationId,
    ).toBe(own.id);
  });
});

describe.skipIf(!PROOF_URL)("the state machine", () => {
  it("first-seen terminal inserts; a late running frame after exited is inert", async () => {
    const agentId = await seedAgent("sm");
    const sb = await seedSandbox("sm", agentId, "running", {
      containerRef: "c",
    });
    // First sight is already terminal (the running frame was dropped).
    await processes.applyProcessState(
      RUNNER_A,
      stateEvent(sb, "c", {
        ref: "p-1",
        status: "exited",
        exitCode: 0,
        endedAt: new Date().toISOString(),
      }),
    );
    let row = await db.sandboxProcess.findUnique({
      where: { sandboxId_ref: { sandboxId: sb, ref: "p-1" } },
      select: { status: true },
    });
    expect(row?.status).toBe("exited");

    // A late `running` frame must NOT resurrect it (the running branch never
    // writes status), and a late DIFFERING terminal (`stopped`) must NOT
    // overwrite it either — the terminal-freeze guard: first terminal wins.
    await processes.applyProcessState(
      RUNNER_A,
      stateEvent(sb, "c", { ref: "p-1", status: "running", tail: "late" }),
    );
    await processes.applyProcessState(
      RUNNER_A,
      stateEvent(sb, "c", {
        ref: "p-1",
        status: "stopped",
        endedAt: new Date().toISOString(),
      }),
    );
    row = await db.sandboxProcess.findUnique({
      where: { sandboxId_ref: { sandboxId: sb, ref: "p-1" } },
      select: { status: true },
    });
    expect(row?.status).toBe("exited");
  });

  it("running→running refreshes the tail", async () => {
    const agentId = await seedAgent("tail");
    const sb = await seedSandbox("tail", agentId, "running", {
      containerRef: "c",
    });
    await processes.applyProcessState(
      RUNNER_A,
      stateEvent(sb, "c", { ref: "p-1", tail: "first" }),
    );
    await processes.applyProcessState(
      RUNNER_A,
      stateEvent(sb, "c", { ref: "p-1", tail: "second" }),
    );
    const row = await db.sandboxProcess.findUnique({
      where: { sandboxId_ref: { sandboxId: sb, ref: "p-1" } },
      select: { tail: true },
    });
    expect(row?.tail).toBe("second");
  });

  it("applies watch frames through applyProcessState: first-sight, armed→triggered, terminal freeze", async () => {
    const agentId = await seedAgent("wsm");
    const sb = await seedSandbox("wsm", agentId, "running", {
      containerRef: "c",
    });
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const w = (over: Record<string, unknown>) => ({
      ref: "w-1",
      kind: "exit",
      prompt: "report",
      status: "armed",
      expiresAt,
      ...over,
    });
    const triggered = (ref: string) =>
      w({
        ref,
        status: "triggered",
        trigger: "exited",
        triggeredAt: new Date().toISOString(),
      });

    // First sight: an armed watch on the frame lands armed.
    await processes.applyProcessState(
      RUNNER_A,
      stateEvent(sb, "c", { ref: "p-1", watches: [w({})] }),
    );
    const w1 = await db.processWatch.findFirstOrThrow({
      where: { process: { sandboxId: sb }, ref: "w-1" },
      select: { id: true, status: true },
    });
    expect(w1.status).toBe("armed");

    // armed → triggered. MUTATION-PROOF: delete the armed→X transition in
    // upsertWatches and this stays armed.
    await processes.applyProcessState(
      RUNNER_A,
      stateEvent(sb, "c", { ref: "p-1", watches: [triggered("w-1")] }),
    );
    expect(
      (
        await db.processWatch.findUniqueOrThrow({
          where: { id: w1.id },
          select: { status: true },
        })
      ).status,
    ).toBe("triggered");

    // Terminal freeze: the control plane marked it fired; a re-sent triggered
    // frame must NOT reopen it. MUTATION-PROOF: remove the TERMINAL_WATCH guard
    // and this reverts to triggered.
    await db.processWatch.update({
      where: { id: w1.id },
      data: { status: "fired", firedAt: new Date() },
    });
    await processes.applyProcessState(
      RUNNER_A,
      stateEvent(sb, "c", { ref: "p-1", watches: [triggered("w-1")] }),
    );
    expect(
      (
        await db.processWatch.findUniqueOrThrow({
          where: { id: w1.id },
          select: { status: true },
        })
      ).status,
    ).toBe("fired");

    // First-sight TRIGGERED (the armed frame dropped) inserts as triggered.
    await processes.applyProcessState(
      RUNNER_A,
      stateEvent(sb, "c", {
        ref: "p-1",
        watches: [triggered("w-2"), triggered("w-1")],
      }),
    );
    expect(
      (
        await db.processWatch.findFirstOrThrow({
          where: { process: { sandboxId: sb }, ref: "w-2" },
          select: { status: true },
        })
      ).status,
    ).toBe("triggered");
  });

  it("a triggered edge marks the watch-fire pass pending, exactly once", async () => {
    const agentId = await seedAgent("wfp");
    const sb = await seedSandbox("wfp", agentId, "running", {
      containerRef: "c",
    });
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    dueWork.takeWatchFirePending(); // drain whatever earlier tests left

    // An armed frame is NOT a fire edge.
    await processes.applyProcessState(
      RUNNER_A,
      stateEvent(sb, "c", {
        ref: "p-1",
        watches: [
          {
            ref: "w-1",
            kind: "exit",
            prompt: "report",
            status: "armed",
            expiresAt,
          },
        ],
      }),
    );
    expect(dueWork.takeWatchFirePending()).toBe(false);

    // The triggered edge marks the pass pending; take() is one-shot, so of
    // all the polls the signal wakes, exactly one runs the fire.
    await processes.applyProcessState(
      RUNNER_A,
      stateEvent(sb, "c", {
        ref: "p-1",
        watches: [
          {
            ref: "w-1",
            kind: "exit",
            prompt: "report",
            status: "triggered",
            trigger: "exited",
            triggeredAt: new Date().toISOString(),
            expiresAt,
          },
        ],
      }),
    );
    expect(dueWork.takeWatchFirePending()).toBe(true);
    expect(dueWork.takeWatchFirePending()).toBe(false);
  });
});

describe.skipIf(!PROOF_URL)("keep-awake (the stop arm)", () => {
  const stale = () => new Date(Date.now() - 60 * 60 * 1000);
  const claimStop = async () =>
    (await dueWork.claimDueWork(RUNNER_A, 5)).filter((i) => i.kind === "stop");

  it("a running process on the CURRENT container blocks the stop; exited does not", async () => {
    const agentId = await seedAgent("ka-run");
    const sb = await seedSandbox("ka-run", agentId, "running", {
      containerRef: "c-cur",
      lastActiveAt: stale(),
    });
    await db.sandboxProcess.create({
      data: {
        sandboxId: sb,
        ref: "p-1",
        containerRef: "c-cur",
        command: "sleep 999",
        status: "running",
        startedAt: new Date(),
      },
    });
    expect(await claimStop()).toEqual([]); // held awake

    // Flip it to exited → nothing keeps it awake now.
    await db.sandboxProcess.updateMany({
      where: { sandboxId: sb, ref: "p-1" },
      data: { status: "exited", endedAt: new Date() },
    });
    const stops = await claimStop();
    expect(stops.map((s) => s.sandboxId)).toContain(sb);
  });

  it("a running process on a STALE container does NOT keep the box awake (the ref term)", async () => {
    const agentId = await seedAgent("ka-stale");
    const sb = await seedSandbox("ka-stale", agentId, "running", {
      containerRef: "c-current",
      lastActiveAt: stale(),
    });
    // The row's container is NOT the sandbox's current one — it is a corpse.
    await db.sandboxProcess.create({
      data: {
        sandboxId: sb,
        ref: "p-old",
        containerRef: "c-previous",
        command: "sleep 999",
        status: "running",
        startedAt: new Date(),
      },
    });
    const stops = await claimStop();
    expect(stops.map((s) => s.sandboxId)).toContain(sb);
  });

  it("an armed watch blocks the stop; a fired/expired one does not", async () => {
    const agentId = await seedAgent("ka-watch");
    const sb = await seedSandbox("ka-watch", agentId, "running", {
      containerRef: "c",
      lastActiveAt: stale(),
    });
    const proc = await db.sandboxProcess.create({
      data: {
        sandboxId: sb,
        ref: "p-1",
        containerRef: "c",
        command: "x",
        status: "exited", // process done, but a watch is armed on it
        endedAt: new Date(),
        startedAt: new Date(),
      },
      select: { id: true },
    });
    const watch = await db.processWatch.create({
      data: {
        processId: proc.id,
        ref: "w-1",
        kind: "exit",
        prompt: "go",
        status: "armed",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
      select: { id: true },
    });
    expect(await claimStop()).toEqual([]); // armed watch holds it

    await db.processWatch.update({
      where: { id: watch.id },
      data: { status: "expired" },
    });
    const stops = await claimStop();
    expect(stops.map((s) => s.sandboxId)).toContain(sb);
  });
});

describe.skipIf(!PROOF_URL)("the held-awake ceiling (the eviction arm)", () => {
  const stale = (hoursAgo: number) =>
    new Date(Date.now() - hoursAgo * 60 * 60 * 1000);

  const setCeilingVia = async (runnerId: string, maxSandboxes: number) => {
    // No MAX_HELD_AWAKE_SANDBOXES in this suite (hermetic env), so the
    // ceiling derives from capabilities: max(1, maxSandboxes − 1). The full
    // registration shape — a partial one fails the schema and floors at 1.
    await db.runner.update({
      where: { id: runnerId },
      data: {
        capabilities: {
          maxSandboxes,
          backend: "docker",
          homeDurability: "resident",
        },
      },
    });
  };

  /** A held-awake box: running, idle past the window, live process on the
   * CURRENT container ref. */
  const seedHeldBox = async (
    suffix: string,
    lastActiveAt: Date,
    runnerId = RUNNER_A,
  ) => {
    const agentId = await seedAgent(suffix);
    const sb = await seedSandbox(suffix, agentId, "running", {
      containerRef: `c-${suffix}`,
      lastActiveAt,
      runnerId,
    });
    await db.sandboxProcess.create({
      data: {
        sandboxId: sb,
        ref: "p-1",
        containerRef: `c-${suffix}`,
        command: "sleep 999",
        status: "running",
        startedAt: new Date(),
      },
    });
    return { agentId, sb };
  };

  const claimStops = async (runnerId = RUNNER_A) =>
    (await dueWork.claimDueWork(runnerId, 5)).filter((i) => i.kind === "stop");

  it("over the ceiling, evicts the OLDEST-idle held boxes and only the excess", async () => {
    await setCeilingVia(RUNNER_A, 3); // ceiling 2
    const oldest = await seedHeldBox("ev-old", stale(3));
    await seedHeldBox("ev-mid", stale(2));
    await seedHeldBox("ev-new", stale(1));

    const stops = await claimStops();
    // excess = 3 − 2 = 1: exactly the LRU box, nothing more.
    expect(stops.map((s) => s.sandboxId)).toEqual([oldest.sb]);
    const row = await db.sandbox.findUnique({
      where: { id: oldest.sb },
      select: { status: true },
    });
    expect(row?.status).toBe("stopping");
  });

  it("at or under the ceiling, keep-awake still holds every box up", async () => {
    await setCeilingVia(RUNNER_A, 3); // ceiling 2
    await seedHeldBox("ev-a", stale(3));
    await seedHeldBox("ev-b", stale(2));

    expect(await claimStops()).toEqual([]);
  });

  it("never evicts a box mid-conversation — the active-turn guard survives", async () => {
    await setCeilingVia(RUNNER_A, 2); // ceiling 1
    const oldest = await seedHeldBox("ev-busy", stale(3));
    const younger = await seedHeldBox("ev-idle", stale(2));
    // The LRU candidate is mid-conversation: it must be skipped, and the
    // next-oldest evicted instead.
    const conversation = await db.conversation.create({
      data: { agentId: oldest.agentId },
      select: { id: true },
    });
    await db.turn.create({
      data: { conversationId: conversation.id, message: "still talking" },
    });

    const stops = await claimStops();
    expect(stops.map((s) => s.sandboxId)).toEqual([younger.sb]);
  });

  it("is runner-fenced: one runner's excess never evicts through another's claim", async () => {
    await setCeilingVia(RUNNER_B, 2); // ceiling 1 on B
    await seedHeldBox("ev-b1", stale(3), RUNNER_B);
    await seedHeldBox("ev-b2", stale(2), RUNNER_B);

    // A's claim sees none of B's excess…
    expect(await claimStops(RUNNER_A)).toEqual([]);
    // …and B's own claim evicts exactly its LRU box.
    const stops = await claimStops(RUNNER_B);
    expect(stops.map((s) => s.sandboxId)).toEqual([`${P}sb-ev-b1`]);
  });
});

describe.skipIf(!PROOF_URL)("the held-awake dashboard signal", () => {
  const seedHeld = async (suffix: string) => {
    const agentId = await seedAgent(suffix);
    const sb = await seedSandbox(suffix, agentId, "running", {
      containerRef: `c-${suffix}`,
    });
    await db.sandboxProcess.create({
      data: {
        sandboxId: sb,
        ref: "p-1",
        containerRef: `c-${suffix}`,
        command: "sleep 999",
        status: "running",
        startedAt: new Date(),
      },
    });
    return agentId;
  };

  it("agentIdsWithLiveBackgroundWork is fenced — a foreign workspace's held agent is invisible", async () => {
    const mine = await seedHeld("sig-mine");

    // A held-awake agent in a DIFFERENT workspace (its own org) — the
    // workspace fence must exclude it. This is the planted cross-tenant
    // negative control for the new fenced query.
    const otherOrg = `${P}sig-org2`;
    const otherWorkspace = `${P}sig-ws2`;
    await db.organization.create({
      data: { id: otherOrg, name: otherOrg, slug: otherOrg },
    });
    await db.workspace.create({
      data: { id: otherWorkspace, name: "other", organizationId: otherOrg },
    });
    const foreignAgent = await db.agent.create({
      data: {
        workspaceId: otherWorkspace,
        name: "foreign",
        identifier: `${P}sig-foreign`,
        accessToken: `aoc_${P}sig-foreign`,
        kind: "hosted",
        harness: "fake",
      },
      select: { id: true },
    });
    const foreignSb = await db.sandbox.create({
      data: {
        id: `${P}sb-sig-foreign`,
        agentId: foreignAgent.id,
        runnerId: RUNNER_A,
        status: "running",
        containerRef: "c-foreign",
        lastActiveAt: new Date(),
        homeAppliedGeneration: 1,
      },
      select: { id: true },
    });
    await db.sandboxProcess.create({
      data: {
        sandboxId: foreignSb.id,
        ref: "p-1",
        containerRef: "c-foreign",
        command: "sleep 999",
        status: "running",
        startedAt: new Date(),
      },
    });

    const busy = await dueWork.agentIdsWithLiveBackgroundWork(WORKSPACE);
    expect(busy.has(mine)).toBe(true);
    expect(busy.has(foreignAgent.id)).toBe(false);

    // And the foreign workspace sees only its own.
    const theirs = await dueWork.agentIdsWithLiveBackgroundWork(otherWorkspace);
    expect(theirs.has(foreignAgent.id)).toBe(true);
    expect(theirs.has(mine)).toBe(false);
    // resetAll (beforeEach) reaps every `P`-prefixed row, foreign org included.
  });
});

describe.skipIf(!PROOF_URL)("the sweeps", () => {
  it("a stopped sandbox loses its running processes, and armed watches trigger 'lost'", async () => {
    const agentId = await seedAgent("sweep-lost");
    const sb = await seedSandbox("sweep-lost", agentId, "stopped", {
      containerRef: "c",
    });
    const proc = await db.sandboxProcess.create({
      data: {
        sandboxId: sb,
        ref: "p-1",
        containerRef: "c",
        command: "x",
        status: "running",
        startedAt: new Date(),
      },
      select: { id: true },
    });
    await db.processWatch.create({
      data: {
        processId: proc.id,
        ref: "w-1",
        kind: "pattern",
        pattern: "Z",
        prompt: "go",
        status: "armed",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    await dueWork.sweepLostProcesses();
    await dueWork.sweepWatchCoherence();

    const p = await db.sandboxProcess.findUnique({
      where: { id: proc.id },
      select: { status: true },
    });
    expect(p?.status).toBe("lost");
    const w = await db.processWatch.findFirst({
      where: { processId: proc.id },
      select: { status: true, trigger: true },
    });
    expect(w).toMatchObject({ status: "triggered", trigger: "lost" });
  });

  it("a dropped exit-trigger is recovered by the coherence sweep as 'exited'", async () => {
    const agentId = await seedAgent("sweep-coh");
    const sb = await seedSandbox("sweep-coh", agentId, "running", {
      containerRef: "c",
    });
    const proc = await db.sandboxProcess.create({
      data: {
        sandboxId: sb,
        ref: "p-1",
        containerRef: "c",
        command: "x",
        status: "exited", // process ended…
        endedAt: new Date(),
        startedAt: new Date(),
      },
      select: { id: true },
    });
    // …but the watch is still armed (its exit-trigger frame was lost).
    await db.processWatch.create({
      data: {
        processId: proc.id,
        ref: "w-1",
        kind: "pattern",
        pattern: "Z",
        prompt: "go",
        status: "armed",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    await dueWork.sweepWatchCoherence();
    const w = await db.processWatch.findFirst({
      where: { processId: proc.id },
      select: { status: true, trigger: true },
    });
    expect(w).toMatchObject({ status: "triggered", trigger: "exited" });
  });

  it("expiry terminalizes an armed watch and NEVER creates a turn", async () => {
    const agentId = await seedAgent("sweep-exp");
    const sb = await seedSandbox("sweep-exp", agentId, "running", {
      containerRef: "c",
    });
    const proc = await db.sandboxProcess.create({
      data: {
        sandboxId: sb,
        ref: "p-1",
        containerRef: "c",
        command: "x",
        status: "running",
        startedAt: new Date(),
      },
      select: { id: true },
    });
    await db.processWatch.create({
      data: {
        processId: proc.id,
        ref: "w-1",
        kind: "pattern",
        pattern: "Z",
        prompt: "go",
        status: "armed",
        expiresAt: new Date(Date.now() - 1_000), // already past
      },
    });
    const before = await db.turn.count({
      where: { conversation: { agentId } },
    });
    await watchFire.fireDueWatches();
    const w = await db.processWatch.findFirst({
      where: { processId: proc.id },
      select: { status: true },
    });
    expect(w?.status).toBe("expired");
    expect(await db.turn.count({ where: { conversation: { agentId } } })).toBe(
      before,
    );
  });

  it("a running process on a STALE container is swept to 'lost' (the ref-mismatch branch)", async () => {
    const agentId = await seedAgent("sweep-ref");
    // The sandbox is RUNNING on its current container; the process row carries
    // a PREVIOUS ref — a corpse from before a respawn (not a stopped sandbox).
    const sb = await seedSandbox("sweep-ref", agentId, "running", {
      containerRef: "c-current",
    });
    const proc = await db.sandboxProcess.create({
      data: {
        sandboxId: sb,
        ref: "p-old",
        containerRef: "c-previous",
        command: "x",
        status: "running",
        startedAt: new Date(),
      },
      select: { id: true },
    });
    await dueWork.sweepLostProcesses();
    // MUTATION-PROOF: delete the `p.container_ref <> s.container_ref` term and
    // this stays 'running'.
    expect(
      (
        await db.sandboxProcess.findUniqueOrThrow({
          where: { id: proc.id },
          select: { status: true },
        })
      ).status,
    ).toBe("lost");
  });

  it("a STARTING sandbox keeping its current ref is NOT spuriously lost", async () => {
    const agentId = await seedAgent("sweep-start");
    // Neither branch may fire: 'starting' is excluded from the status list,
    // and the refs match so the mismatch branch is false.
    const sb = await seedSandbox("sweep-start", agentId, "starting", {
      containerRef: "c",
    });
    const proc = await db.sandboxProcess.create({
      data: {
        sandboxId: sb,
        ref: "p-1",
        containerRef: "c",
        command: "x",
        status: "running",
        startedAt: new Date(),
      },
      select: { id: true },
    });
    await dueWork.sweepLostProcesses();
    // MUTATION-PROOF: add 'starting' to the sweep's status list and this
    // becomes 'lost' mid-boot.
    expect(
      (
        await db.sandboxProcess.findUniqueOrThrow({
          where: { id: proc.id },
          select: { status: true },
        })
      ).status,
    ).toBe("running");
  });

  it("coherence runs BEFORE expiry: a terminal-process watch past its deadline still FIRES, never expires", async () => {
    const agentId = await seedAgent("coh-exp");
    const sb = await seedSandbox("coh-exp", agentId, "running", {
      containerRef: "c",
    });
    const proc = await db.sandboxProcess.create({
      data: {
        sandboxId: sb,
        ref: "p-1",
        containerRef: "c",
        command: "x",
        status: "exited", // the process ended…
        endedAt: new Date(),
        startedAt: new Date(),
      },
      select: { id: true },
    });
    // …with a watch still armed AND already past its deadline. Coherence (run
    // first) converts armed→triggered; expiry must not steal it.
    await db.processWatch.create({
      data: {
        processId: proc.id,
        ref: "w-1",
        kind: "exit",
        prompt: "report",
        status: "armed",
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    await watchFire.fireDueWatches();
    // MUTATION-PROOF: reorder sweepExpiredWatches before sweepWatchCoherence in
    // fireDueWatches and this becomes 'expired' — the fire silently lost.
    expect(
      (
        await db.processWatch.findFirstOrThrow({
          where: { process: { sandboxId: sb }, ref: "w-1" },
          select: { status: true },
        })
      ).status,
    ).toBe("fired");
  });
});

describe.skipIf(!PROOF_URL)("the fire", () => {
  const armTriggered = async (agentId: string, sb: string) => {
    const proc = await db.sandboxProcess.create({
      data: {
        sandboxId: sb,
        ref: "p-1",
        containerRef: "c",
        command: "npm test",
        name: "tests",
        status: "exited",
        exitCode: 0,
        endedAt: new Date(),
        startedAt: new Date(),
      },
      select: { id: true },
    });
    return db.processWatch.create({
      data: {
        processId: proc.id,
        ref: "w-1",
        kind: "exit",
        prompt: "Report the test result.",
        status: "triggered",
        trigger: "exited",
        triggeredAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
      select: { id: true },
    });
  };

  it("fires exactly one turn in a source:'watch' conversation, and never re-claims (one-shot)", async () => {
    const agentId = await seedAgent("fire");
    const sb = await seedSandbox("fire", agentId, "running", {
      containerRef: "c",
    });
    const watch = await armTriggered(agentId, sb);

    // Two concurrent fire passes: the claim's SKIP LOCKED + lease means only
    // one fires (the cron.pg concurrency proof, for watches).
    await Promise.all([watchFire.fireDueWatches(), watchFire.fireDueWatches()]);

    const conv = await db.conversation.findFirst({
      where: { agentId, source: "watch", externalRef: watch.id },
      select: { id: true },
    });
    expect(conv).not.toBeNull();
    expect(await db.turn.count({ where: { conversationId: conv!.id } })).toBe(
      1,
    );
    const w = await db.processWatch.findUnique({
      where: { id: watch.id },
      select: { status: true },
    });
    expect(w?.status).toBe("fired");

    // A fired watch is terminal — a later pass claims nothing.
    await watchFire.fireDueWatches();
    expect(await db.turn.count({ where: { conversationId: conv!.id } })).toBe(
      1,
    );
  });

  it("a keyless agent still FIRES the watch and delivers a 'could not start' report to the origin (Q7)", async () => {
    // Door 1 (no model key) refuses the run at creation. Unlike a cron, a
    // watch has no next occurrence — so the fire is terminal regardless, and
    // the failure is delivered to the origin rather than vanishing silently.
    const agentId = await seedAgent("fire-door1"); // no LLM secret granted
    const sb = await seedSandbox("fire-door1", agentId, "running", {
      containerRef: "c",
    });
    const origin = await db.conversation.create({
      data: { agentId, source: "web" },
      select: { id: true },
    });
    const proc = await db.sandboxProcess.create({
      data: {
        sandboxId: sb,
        ref: "p-1",
        containerRef: "c",
        command: "npm test",
        name: "tests",
        status: "exited",
        exitCode: 1,
        endedAt: new Date(),
        startedAt: new Date(),
      },
      select: { id: true },
    });
    const watch = await db.processWatch.create({
      data: {
        processId: proc.id,
        ref: "w-1",
        kind: "exit",
        prompt: "Report the result.",
        status: "triggered",
        trigger: "exited",
        triggeredAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
        originConversationId: origin.id,
      },
      select: { id: true },
    });

    await watchFire.fireDueWatches();

    // One-shot: fired regardless of the run's outcome.
    const w = await db.processWatch.findUnique({
      where: { id: watch.id },
      select: { status: true },
    });
    expect(w?.status).toBe("fired");
    // The origin got a terminal delivery turn saying it could not start.
    const delivery = await db.turn.findFirst({
      where: { conversationId: origin.id, source: "watch", status: "done" },
      select: { id: true },
    });
    expect(delivery).not.toBeNull();
    const text = await db.turnEvent.findFirst({
      where: { turnId: delivery!.id, type: "text" },
      select: { payload: true },
    });
    expect(String((text?.payload as { text?: unknown })?.text ?? "")).toContain(
      "could not start",
    );
  });

  it("honors the fire-claim lease: a fresh claim is not re-taken within the window, a stale one is", async () => {
    const agentId = await seedAgent("lease");
    const sb = await seedSandbox("lease", agentId, "running", {
      containerRef: "c",
    });
    const watch = await armTriggered(agentId, sb);

    // First claim takes it (fire_claimed_at = now); the row stays `triggered`
    // (fireOne, not the claim, moves it to `fired`).
    const first = await dueWork.claimTriggeredWatches();
    expect(first.map((wf) => wf.id)).toContain(watch.id);

    // An immediate second claim must NOT re-take it within the 300s lease.
    // MUTATION-PROOF: drop the `fire_claimed_at < retryBefore` guard and this
    // re-claims it — isolated from the conversation-unique (no turn created).
    const second = await dueWork.claimTriggeredWatches();
    expect(second.map((wf) => wf.id)).not.toContain(watch.id);

    // Age the claim past the lease → a dead poller's claim is reconsidered.
    await db.processWatch.update({
      where: { id: watch.id },
      data: { fireClaimedAt: new Date(Date.now() - 600_000) },
    });
    const third = await dueWork.claimTriggeredWatches();
    expect(third.map((wf) => wf.id)).toContain(watch.id);
  });

  it("a finished watch run delivers ONE report to the origin (source: 'watch'), exactly once", async () => {
    const agentId = await seedAgent("settle");
    await grantLlmKey(agentId, "settle"); // keyed → the run is born, not door-1
    const sb = await seedSandbox("settle", agentId, "running", {
      containerRef: "c",
    });
    const origin = await db.conversation.create({
      data: { agentId, source: "web" },
      select: { id: true },
    });
    const proc = await db.sandboxProcess.create({
      data: {
        sandboxId: sb,
        ref: "p-1",
        containerRef: "c",
        command: "npm test",
        name: "tests",
        status: "exited",
        exitCode: 0,
        endedAt: new Date(),
        startedAt: new Date(),
      },
      select: { id: true },
    });
    await db.processWatch.create({
      data: {
        processId: proc.id,
        ref: "w-1",
        kind: "exit",
        prompt: "Report the result.",
        status: "triggered",
        trigger: "exited",
        triggeredAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
        originConversationId: origin.id,
      },
    });

    await watchFire.fireDueWatches();
    // The run turn born in the watch's own conversation; drive it to a
    // finished run the way the runner would, then settle.
    const run = await db.turn.findFirstOrThrow({
      where: { conversation: { agentId, source: "watch" } },
      select: { id: true, conversationId: true },
    });
    await db.turn.update({
      where: { id: run.id },
      data: { status: "running" },
    });
    const conv = await db.conversation.update({
      where: { id: run.conversationId },
      data: { lastSeq: { increment: 1 } },
      select: { lastSeq: true },
    });
    await db.turnEvent.create({
      data: {
        conversationId: run.conversationId,
        turnId: run.id,
        seq: conv.lastSeq,
        type: "text",
        payload: { type: "text", text: "the watch report body" },
      },
    });

    const finish = () =>
      turnService.finishTurn({
        reporter: { sandboxId: sb, runnerId: RUNNER_A },
        conversationId: run.conversationId,
        turnId: run.id,
        status: "done",
      });
    await finish();
    await finish(); // a duplicate settle must not deliver twice

    // The report lands ONCE in the origin, as a source:"watch" delivery whose
    // header names the process. MUTATION-PROOF: a wrong source/header in
    // settleWatchRun (or dropping the finishTurn transition gate) fails this.
    const deliveries = await db.turn.findMany({
      where: { conversationId: origin.id, source: "watch" },
      select: { id: true, message: true },
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.message).toContain(`Watch on "tests"`);
    const text = await db.turnEvent.findFirstOrThrow({
      where: { turnId: deliveries[0]!.id, type: "text" },
      select: { payload: true },
    });
    expect((text.payload as { text: string }).text).toContain(
      "the watch report body",
    );
  });
});

describe.skipIf(!PROOF_URL)("the coherence CHECKs", () => {
  it("rejects a pattern watch with no pattern, and a triggered watch with no trigger", async () => {
    const agentId = await seedAgent("chk");
    const sb = await seedSandbox("chk", agentId, "running", {
      containerRef: "c",
    });
    const proc = await db.sandboxProcess.create({
      data: {
        sandboxId: sb,
        ref: "p-1",
        containerRef: "c",
        command: "x",
        status: "running",
        startedAt: new Date(),
      },
      select: { id: true },
    });
    await expect(
      db.processWatch.create({
        data: {
          processId: proc.id,
          ref: "bad-kind",
          kind: "pattern", // but no pattern
          prompt: "go",
          status: "armed",
          expiresAt: new Date(Date.now() + 1000),
        },
      }),
    ).rejects.toThrow(/process_watches_kind_coherent/);

    await expect(
      db.processWatch.create({
        data: {
          processId: proc.id,
          ref: "bad-status",
          kind: "exit",
          prompt: "go",
          status: "triggered", // but no trigger / triggeredAt
          expiresAt: new Date(Date.now() + 1000),
        },
      }),
    ).rejects.toThrow(/process_watches_status_coherent/);
  });

  it("rejects a terminal process with no endedAt", async () => {
    const agentId = await seedAgent("chk2");
    const sb = await seedSandbox("chk2", agentId, "running", {
      containerRef: "c",
    });
    await expect(
      db.sandboxProcess.create({
        data: {
          sandboxId: sb,
          ref: "p-bad",
          containerRef: "c",
          command: "x",
          status: "exited", // terminal but endedAt missing
          startedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/sandbox_processes_ended_coherent/);
  });

  it("rejects a fired watch with no fired_at (the status↔fired_at clause)", async () => {
    const agentId = await seedAgent("chk3");
    const sb = await seedSandbox("chk3", agentId, "running", {
      containerRef: "c",
    });
    const proc = await db.sandboxProcess.create({
      data: {
        sandboxId: sb,
        ref: "p-1",
        containerRef: "c",
        command: "x",
        status: "running",
        startedAt: new Date(),
      },
      select: { id: true },
    });
    await expect(
      db.processWatch.create({
        data: {
          processId: proc.id,
          ref: "bad-fired",
          kind: "exit",
          prompt: "go",
          status: "fired", // terminal + trigger present…
          trigger: "exited",
          triggeredAt: new Date(),
          // …but fired_at is missing — the fired⇔fired_at clause must reject.
          expiresAt: new Date(Date.now() + 1000),
        },
      }),
    ).rejects.toThrow(/process_watches_status_coherent/);
  });
});

describe.skipIf(!PROOF_URL)(
  "the applyRunnerEvent ref split (step 10 Hole 1)",
  () => {
    it("lands the container ref even when the sandbox already reads running", async () => {
      const agentId = await seedAgent("refsplit");
      // A `supervisor.ready` raced ahead: the row is running with a null ref.
      await db.sandbox.create({
        data: {
          id: `${P}sb-refsplit`,
          agentId,
          runnerId: RUNNER_A,
          status: "running",
          containerRef: null,
          lastActiveAt: new Date(),
          homeAppliedGeneration: 1,
        },
      });
      // The late `starting` report carries the ref; the status guard would drop
      // the whole write, but the split lands the ref regardless.
      await sandboxes.applyRunnerEvent(RUNNER_A, {
        kind: "sandbox.status",
        sandboxId: `${P}sb-refsplit`,
        status: "starting",
        containerRef: "cont-late",
      });
      const row = await db.sandbox.findUnique({
        where: { id: `${P}sb-refsplit` },
        select: { status: true, containerRef: true },
      });
      // Status stayed running (guard held); ref landed (split).
      expect(row?.status).toBe("running");
      expect(row?.containerRef).toBe("cont-late");
    });
  },
);

describe.skipIf(!PROOF_URL)("the in-origin wake (direct origins)", () => {
  const directOrigin = (agentId: string) =>
    db.conversation.create({
      data: { agentId, source: "web", direct: true, userId: USER },
      select: { id: true },
    });

  const armTriggeredWithOrigin = async (
    sb: string,
    originId: string,
    suffix: string,
    overrides: Record<string, unknown> = {},
  ) => {
    const proc = await db.sandboxProcess.create({
      data: {
        sandboxId: sb,
        ref: `p-${suffix}`,
        containerRef: "c",
        command: `job ${suffix}`,
        name: `job-${suffix}`,
        status: "exited",
        exitCode: 0,
        endedAt: new Date(),
        startedAt: new Date(),
      },
      select: { id: true },
    });
    return db.processWatch.create({
      data: {
        processId: proc.id,
        ref: `w-${suffix}`,
        kind: "exit",
        prompt: "Report the result.",
        status: "triggered",
        trigger: "exited",
        triggeredAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
        originConversationId: originId,
        createdByUserId: USER,
        ...overrides,
      },
      select: { id: true },
    });
  };

  it("fires ONE consolidated turn INSIDE the direct origin — no hidden conversation", async () => {
    const agentId = await seedAgent("inorigin");
    const sb = await seedSandbox("inorigin", agentId, "running", {
      containerRef: "c",
    });
    const origin = await directOrigin(agentId);
    const wa = await armTriggeredWithOrigin(sb, origin.id, "a");
    const wb = await armTriggeredWithOrigin(sb, origin.id, "b");

    await watchFire.fireDueWatches();

    const originTurns = await db.turn.findMany({
      where: { conversationId: origin.id },
      select: { message: true, source: true, userId: true },
    });
    expect(originTurns).toHaveLength(1);
    expect(originTurns[0]?.source).toBe("watch");
    expect(originTurns[0]?.userId).toBeNull();
    expect(originTurns[0]?.message).toContain("2 background task(s)");
    expect(originTurns[0]?.message).toContain('"job-a"');
    expect(originTurns[0]?.message).toContain('"job-b"');
    // The shared prompt is stated once, not per watch.
    expect(originTurns[0]?.message.split("Report the result.")).toHaveLength(2);

    // No hidden per-watch conversation was minted for either watch.
    expect(
      await db.conversation.count({
        where: {
          agentId,
          source: "watch",
          externalRef: { in: [wa.id, wb.id] },
        },
      }),
    ).toBe(0);
    const statuses = await db.processWatch.findMany({
      where: { id: { in: [wa.id, wb.id] } },
      select: { status: true },
    });
    expect(statuses.map((row) => row.status)).toEqual(["fired", "fired"]);
  });

  it("a busy origin keeps the wake CLAIMED for retry, and the freed slot releases it", async () => {
    const agentId = await seedAgent("inorigin-busy");
    const sb = await seedSandbox("inorigin-busy", agentId, "running", {
      containerRef: "c",
    });
    const origin = await directOrigin(agentId);
    const blocker = await db.turn.create({
      data: {
        conversationId: origin.id,
        message: "still typing",
        status: "queued",
        source: "web",
        userId: USER,
      },
      select: { id: true },
    });
    const watch = await armTriggeredWithOrigin(sb, origin.id, "busy");

    await watchFire.fireDueWatches();

    // Not fired, not dropped — claimed, waiting on the lease.
    const afterBusy = await db.processWatch.findUniqueOrThrow({
      where: { id: watch.id },
      select: { status: true, fireClaimedAt: true },
    });
    expect(afterBusy.status).toBe("triggered");
    expect(afterBusy.fireClaimedAt).not.toBeNull();
    expect(await db.turn.count({ where: { conversationId: origin.id } })).toBe(
      1,
    );

    // The finished-turn nudge puts the bucket back in the next poll's reach.
    await dueWork.releaseWatchFireClaimsForConversation(origin.id);
    expect(
      (
        await db.processWatch.findUniqueOrThrow({
          where: { id: watch.id },
          select: { fireClaimedAt: true },
        })
      ).fireClaimedAt,
    ).toBeNull();

    await db.turn.delete({ where: { id: blocker.id } });
    await watchFire.fireDueWatches();

    const turns = await db.turn.findMany({
      where: { conversationId: origin.id },
      select: { source: true },
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.source).toBe("watch");
    expect(
      (
        await db.processWatch.findUniqueOrThrow({
          where: { id: watch.id },
          select: { status: true },
        })
      ).status,
    ).toBe("fired");
  });

  it("a busy origin DOWNGRADES an expired watch to the hidden path", async () => {
    const agentId = await seedAgent("inorigin-exp");
    const sb = await seedSandbox("inorigin-exp", agentId, "running", {
      containerRef: "c",
    });
    const origin = await directOrigin(agentId);
    await db.turn.create({
      data: {
        conversationId: origin.id,
        message: "still typing",
        status: "queued",
        source: "web",
        userId: USER,
      },
    });
    const watch = await armTriggeredWithOrigin(sb, origin.id, "exp", {
      expiresAt: new Date(Date.now() - 1_000),
    });

    await watchFire.fireDueWatches();

    // The hidden run conversation exists and carries the fire.
    const hidden = await db.conversation.findFirst({
      where: { agentId, source: "watch", externalRef: watch.id },
      select: { id: true },
    });
    expect(hidden).not.toBeNull();
    expect(await db.turn.count({ where: { conversationId: hidden!.id } })).toBe(
      1,
    );
    expect(
      (
        await db.processWatch.findUniqueOrThrow({
          where: { id: watch.id },
          select: { status: true },
        })
      ).status,
    ).toBe("fired");
  });

  it("an in-origin wake turn's close settles nothing extra — the turn IS the report", async () => {
    const agentId = await seedAgent("inorigin-settle");
    await grantLlmKey(agentId, "inorigin-settle");
    const sb = await seedSandbox("inorigin-settle", agentId, "running", {
      containerRef: "c",
    });
    const origin = await directOrigin(agentId);
    await armTriggeredWithOrigin(sb, origin.id, "settle");

    await watchFire.fireDueWatches();
    const wake = await db.turn.findFirstOrThrow({
      where: { conversationId: origin.id, source: "watch" },
      select: { id: true },
    });
    // The reporter fence needs dispatched/running — flip it the way the
    // runner would, then close.
    await db.turn.update({
      where: { id: wake.id },
      data: { status: "running" },
    });
    await turnService.finishTurn({
      reporter: { sandboxId: sb, runnerId: RUNNER_A },
      conversationId: origin.id,
      turnId: wake.id,
      status: "done",
    });

    // No delivery duplicate materialized: the wake turn is the only row.
    expect(await db.turn.count({ where: { conversationId: origin.id } })).toBe(
      1,
    );
  });

  it("a creator that is not the thread owner keeps the hidden path — never a DM write", async () => {
    const agentId = await seedAgent("inorigin-foreign");
    const sb = await seedSandbox("inorigin-foreign", agentId, "running", {
      containerRef: "c",
    });
    const stranger = await db.user.upsert({
      where: { id: `${P}stranger` },
      create: {
        id: `${P}stranger`,
        email: `${P}stranger@example.com`,
        externalAuthId: `${P}s`,
      },
      update: {},
      select: { id: true },
    });
    const origin = await db.conversation.create({
      data: { agentId, source: "web", direct: true, userId: stranger.id },
      select: { id: true },
    });
    const watch = await armTriggeredWithOrigin(sb, origin.id, "foreign");

    await watchFire.fireDueWatches();

    // The WAKE ran in the hidden per-watch conversation, not the DM. (The
    // door-1 refusal delivery — a born-done record — may still land in the
    // origin; that is the hidden path's own, pre-existing behavior.)
    expect(
      await db.turn.count({
        where: { conversationId: origin.id, status: { not: "done" } },
      }),
    ).toBe(0);
    const hidden = await db.conversation.findFirst({
      where: { agentId, source: "watch", externalRef: watch.id },
      select: { id: true },
    });
    expect(hidden).not.toBeNull();
    expect(await db.turn.count({ where: { conversationId: hidden!.id } })).toBe(
      1,
    );
    await db.user.delete({ where: { id: stranger.id } });
  });
});
