import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * The runner multi-copy channel plane on REAL PostgreSQL. Every law here is a
 * fenced UPDATE whose correctness only shows against a real row:
 *
 * - the spawn record applies only while the sandbox is still starting;
 * - a bootstrap token works exactly once, even with two copies racing it;
 * - a session claim applies only for the current container, never while a
 *   newer spawn waits for its first connect, never over a newer socket;
 * - a release applies only for the connection still holding the channel;
 * - socket-bound work is claimed only by the holder copy, and a
 *   single-process runner (no copy id) is not fenced;
 * - the reconcile listing reports each channel state and picks the oldest
 *   live copy as reconciler, handing over when it dies;
 * - a report about one container never lands on a newer one;
 * - a stray stop never beats a start to the same sandbox;
 * - a sandbox's lifecycle steps (start, stop, evict, stray stop) belong to
 *   one owning copy at a time, pass on only when it dies or retires, and a
 *   start's spawn record and reports apply only from that owner.
 *
 * Env-gated like the other proof suites; see pg-proof.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type DueWork = typeof import("./due-work");
type Sandboxes = typeof import("./sandbox-service");
type Channels = typeof import("./runner-channel-service");
type Runners = typeof import("./runner-service");

let db: Db;
let dueWork: DueWork;
let sandboxes: Sandboxes;
let channels: Channels;
let runners: Runners;

const P = "rch-";
const ORG = `${P}org`;
const WORKSPACE = `${P}proj`;
const RUNNER = `${P}runner`;
const OTHER_RUNNER = `${P}runner-other`;
const COPY_A = `${P}copy-a`;
const COPY_B = `${P}copy-b`;

const CAPABILITIES = {
  maxSandboxes: 4,
  backend: "docker",
  homeDurability: "resident",
  steerMessages: true,
  sendNow: true,
};

const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);
const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60 * 1000);

const cleanup = async () => {
  await db.sandbox.deleteMany({
    where: {
      OR: [
        { id: { startsWith: P } },
        { runnerId: { in: [RUNNER, OTHER_RUNNER] } },
      ],
    },
  });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: { startsWith: P } } });
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

/** A sandbox with its agent; `channel` writes the channel columns raw, the
 * way the service does (they are never written through Prisma). */
const seedSandbox = async (
  suffix: string,
  data: {
    status: string;
    runnerId?: string;
    containerRef?: string;
    owner?: string;
    channel?: {
      replicaId?: string;
      connectionId?: string;
      tokenHash?: string;
      since?: Date;
    };
  },
) => {
  const agentId = await seedAgent(suffix);
  const id = `${P}sb-${suffix}`;
  await db.sandbox.create({
    data: {
      id,
      agentId,
      runnerId: data.runnerId ?? RUNNER,
      status: data.status,
      homeAppliedGeneration: 1,
      ...(data.containerRef && { containerRef: data.containerRef }),
      ...(data.owner && { ownerReplicaId: data.owner }),
    },
  });
  if (data.channel) {
    await db.$executeRaw`
      UPDATE sandboxes SET
        channel_replica_id = ${data.channel.replicaId ?? null},
        channel_connection_id = ${data.channel.connectionId ?? null},
        channel_token_hash = ${data.channel.tokenHash ?? null},
        channel_since = ${data.channel.since ?? new Date()}
      WHERE id = ${id}
    `;
  }
  return { id, agentId };
};

const channelOf = async (id: string) => {
  const [row] = await db.$queryRaw<
    {
      container_ref: string | null;
      channel_replica_id: string | null;
      channel_connection_id: string | null;
      channel_token_hash: string | null;
      channel_since: Date | null;
      owner_replica_id: string | null;
      status: string;
    }[]
  >`
    SELECT container_ref, channel_replica_id, channel_connection_id,
           channel_token_hash, channel_since, owner_replica_id, status
    FROM sandboxes WHERE id = ${id}
  `;
  return row;
};

const seedQueuedTurn = async (agentId: string, suffix: string) => {
  await db.conversation.create({
    data: { id: `${P}cv-${suffix}`, agentId, source: "web" },
  });
  await db.turn.create({
    data: {
      id: `${P}t-${suffix}`,
      conversationId: `${P}cv-${suffix}`,
      message: "hello",
      status: "queued",
    },
  });
};

const setReplicaSeen = async (id: string, at: Date) => {
  await db.runnerReplica.update({ where: { id }, data: { lastSeenAt: at } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.SANDBOX_IDLE_STOP_SECONDS = "600";
  process.env.RUNNER_ONLINE_THRESHOLD_SECONDS = "90";

  ({ db } = await import("@onecli/db"));
  // Boot like the server: the runner poll reads edition seams (the hosted
  // desktop's push claim on cloud), which fail loudly when never injected.
  const { ensureEditionDefaults } = await import("../edition-defaults");
  ensureEditionDefaults();
  dueWork = await import("./due-work");
  sandboxes = await import("./sandbox-service");
  channels = await import("./runner-channel-service");
  runners = await import("./runner-service");

  await cleanup();
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "Channel Workspace", organizationId: ORG },
  });
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await cleanup();
  // Offline runners (no lastSeenAt): claims are fenced by id, not liveness,
  // and an offline runner never receives another suite's placements.
  await db.runner.createMany({
    data: [
      {
        id: RUNNER,
        name: "runner",
        token: `rnr_${P}main`,
        capabilities: CAPABILITIES,
      },
      {
        id: OTHER_RUNNER,
        name: "other",
        token: `rnr_${P}other`,
        capabilities: CAPABILITIES,
      },
    ],
  });
  // Copy A is the older one; both live.
  await db.runnerReplica.createMany({
    data: [
      { id: COPY_A, runnerId: RUNNER, name: "a", createdAt: minutesAgo(10) },
      { id: COPY_B, runnerId: RUNNER, name: "b", createdAt: minutesAgo(5) },
    ],
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await cleanup();
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.$disconnect();
});

describe.skipIf(!PROOF_URL)("the spawn record", () => {
  it("records the container and token hash while the owner's start runs", async () => {
    const { id } = await seedSandbox("spawn-ok", {
      status: "starting",
      owner: COPY_A,
      channel: { replicaId: COPY_B, connectionId: "old-conn" },
    });

    expect(
      await channels.recordSpawn(RUNNER, COPY_A, id, {
        containerRef: "ctr-1",
        tokenHash: HASH_1,
      }),
    ).toBe(true);

    const row = await channelOf(id);
    expect(row?.container_ref).toBe("ctr-1");
    expect(row?.channel_token_hash).toBe(HASH_1);
    // The previous container's channel stops counting at once.
    expect(row?.channel_replica_id).toBeNull();
    expect(row?.channel_connection_id).toBeNull();
  });

  it("is refused once the sandbox moved on, for a copy that lost ownership, and for another runner", async () => {
    const { id } = await seedSandbox("spawn-late", {
      status: "running",
      owner: COPY_A,
    });
    expect(
      await channels.recordSpawn(RUNNER, COPY_A, id, {
        containerRef: "ctr-x",
        tokenHash: HASH_1,
      }),
    ).toBe(false);

    // The fencing token: copy A paused mid-create, copy B took over.
    const { id: overtaken } = await seedSandbox("spawn-overtaken", {
      status: "starting",
      owner: COPY_B,
    });
    expect(
      await channels.recordSpawn(RUNNER, COPY_A, overtaken, {
        containerRef: "ctr-stale",
        tokenHash: HASH_1,
      }),
    ).toBe(false);
    expect((await channelOf(overtaken))?.container_ref).toBeNull();

    const { id: other } = await seedSandbox("spawn-other", {
      status: "starting",
      owner: COPY_A,
    });
    expect(
      await channels.recordSpawn(OTHER_RUNNER, COPY_A, other, {
        containerRef: "ctr-x",
        tokenHash: HASH_1,
      }),
    ).toBe(false);
    expect((await channelOf(other))?.channel_token_hash).toBeNull();
  });
});

describe.skipIf(!PROOF_URL)("the token door", () => {
  it("uses the token exactly once, names the holder, and wakes the held poll", async () => {
    const { id } = await seedSandbox("tok-once", {
      status: "starting",
      containerRef: "ctr-1",
      channel: { tokenHash: HASH_1 },
    });
    const connectedAt = Date.now();
    // Work that waited while the channel was between copies is dispatchable
    // the moment a copy holds it.
    const woken = dueWork.waitForWork(10_000);

    const first = await channels.claimChannel(RUNNER, COPY_B, {
      door: "token",
      connectionId: "conn-1",
      connectedAt,
      tokenHash: HASH_1,
    });
    expect(first).toEqual({ sandboxId: id, containerRef: "ctr-1" });
    expect(await woken).toBe(true);

    const row = await channelOf(id);
    expect(row?.channel_token_hash).toBeNull();
    expect(row?.channel_replica_id).toBe(COPY_B);
    expect(row?.channel_connection_id).toBe("conn-1");

    // Possession of the token proves nothing a second time, on any copy.
    expect(
      await channels.claimChannel(RUNNER, COPY_A, {
        door: "token",
        connectionId: "conn-2",
        connectedAt,
        tokenHash: HASH_1,
      }),
    ).toBeNull();
  });

  it("two copies racing one token: exactly one wins", async () => {
    await seedSandbox("tok-race", {
      status: "starting",
      containerRef: "ctr-1",
      channel: { tokenHash: HASH_1 },
    });
    const claim = (replicaId: string, connectionId: string) =>
      channels.claimChannel(RUNNER, replicaId, {
        door: "token",
        connectionId,
        connectedAt: Date.now(),
        tokenHash: HASH_1,
      });

    const results = await Promise.all([
      claim(COPY_A, "race-a"),
      claim(COPY_B, "race-b"),
    ]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
  });

  it("refuses an unknown hash and another runner's token", async () => {
    await seedSandbox("tok-fence", {
      status: "starting",
      containerRef: "ctr-1",
      channel: { tokenHash: HASH_1 },
    });
    const claim = (runnerId: string, tokenHash: string) =>
      channels.claimChannel(runnerId, COPY_A, {
        door: "token",
        connectionId: "c",
        connectedAt: Date.now(),
        tokenHash,
      });
    expect(await claim(RUNNER, HASH_2)).toBeNull();
    expect(await claim(OTHER_RUNNER, HASH_1)).toBeNull();
  });
});

describe.skipIf(!PROOF_URL)("the session door", () => {
  it("moves the channel to the claiming copy for the current container", async () => {
    const { id } = await seedSandbox("ses-move", {
      status: "running",
      containerRef: "ctr-1",
      channel: {
        replicaId: COPY_A,
        connectionId: "conn-a",
        since: new Date(Date.now() - 10_000),
      },
    });

    const claimed = await channels.claimChannel(RUNNER, COPY_B, {
      door: "session",
      connectionId: "conn-b",
      connectedAt: Date.now(),
      sandboxId: id,
      containerRef: "ctr-1",
    });
    expect(claimed).toEqual({ sandboxId: id, containerRef: "ctr-1" });
    const row = await channelOf(id);
    expect(row?.channel_replica_id).toBe(COPY_B);
    expect(row?.channel_connection_id).toBe("conn-b");
  });

  it("refuses a replaced container, a waiting spawn, and a claim older than the holder", async () => {
    const { id: replaced } = await seedSandbox("ses-ref", {
      status: "running",
      containerRef: "ctr-new",
    });
    expect(
      await channels.claimChannel(RUNNER, COPY_A, {
        door: "session",
        connectionId: "c1",
        connectedAt: Date.now(),
        sandboxId: replaced,
        containerRef: "ctr-old",
      }),
    ).toBeNull();

    // A newer spawn waits for its own first connect: the old container's
    // session must not take the channel meanwhile.
    const { id: waiting } = await seedSandbox("ses-wait", {
      status: "starting",
      containerRef: "ctr-1",
      channel: { tokenHash: HASH_1 },
    });
    expect(
      await channels.claimChannel(RUNNER, COPY_A, {
        door: "session",
        connectionId: "c2",
        connectedAt: Date.now(),
        sandboxId: waiting,
        containerRef: "ctr-1",
      }),
    ).toBeNull();

    // A late (retried) claim must not steal the channel from a newer socket.
    const holderSince = new Date();
    const { id: held } = await seedSandbox("ses-older", {
      status: "running",
      containerRef: "ctr-1",
      channel: {
        replicaId: COPY_B,
        connectionId: "newer",
        since: holderSince,
      },
    });
    expect(
      await channels.claimChannel(RUNNER, COPY_A, {
        door: "session",
        connectionId: "older",
        connectedAt: holderSince.getTime() - 5_000,
        sandboxId: held,
        containerRef: "ctr-1",
      }),
    ).toBeNull();
    expect((await channelOf(held))?.channel_connection_id).toBe("newer");
  });

  it("refuses another runner's sandbox, even with the right container", async () => {
    // The session door's runner fence: a copy of one runner can never take
    // the channel of a sandbox another runner hosts.
    const { id } = await seedSandbox("ses-foreign", {
      status: "running",
      runnerId: OTHER_RUNNER,
      containerRef: "ctr-1",
    });
    expect(
      await channels.claimChannel(RUNNER, COPY_A, {
        door: "session",
        connectionId: "c",
        connectedAt: Date.now(),
        sandboxId: id,
        containerRef: "ctr-1",
      }),
    ).toBeNull();
    expect((await channelOf(id))?.channel_replica_id).toBeNull();
  });
});

describe.skipIf(!PROOF_URL)("release", () => {
  it("applies only for the connection still holding the channel", async () => {
    const { id } = await seedSandbox("rel", {
      status: "running",
      containerRef: "ctr-1",
      channel: { replicaId: COPY_B, connectionId: "current" },
    });

    // A late release from the connection it moved away from: no change.
    await channels.releaseChannel(RUNNER, COPY_A, "stale");
    await channels.releaseChannel(RUNNER, COPY_A, "current");
    // The same copy's older socket, closing after the supervisor reconnected
    // to that copy on a new one.
    await channels.releaseChannel(RUNNER, COPY_B, "previous");
    expect((await channelOf(id))?.channel_connection_id).toBe("current");

    await channels.releaseChannel(RUNNER, COPY_B, "current");
    const row = await channelOf(id);
    expect(row?.channel_connection_id).toBeNull();
    // The copy stays recorded, so the drop reads as `dropped`, not `none`.
    expect(row?.channel_replica_id).toBe(COPY_B);
  });

  it("never releases another runner's channel", async () => {
    const { id } = await seedSandbox("rel-foreign", {
      status: "running",
      runnerId: OTHER_RUNNER,
      containerRef: "ctr-1",
      channel: { replicaId: COPY_A, connectionId: "theirs" },
    });
    await channels.releaseChannel(RUNNER, COPY_A, "theirs");
    expect((await channelOf(id))?.channel_connection_id).toBe("theirs");
  });
});

describe.skipIf(!PROOF_URL)("socket-bound work follows the channel", () => {
  it("only the holder copy is handed a turn; a single-process runner is not fenced", async () => {
    const { agentId } = await seedSandbox("turn-holder", {
      status: "running",
      containerRef: "ctr-1",
      channel: { replicaId: COPY_B, connectionId: "conn-b" },
    });
    await seedQueuedTurn(agentId, "holder");

    expect(await dueWork.claimDueWork(RUNNER, 5, COPY_A)).toEqual([]);
    const held = await dueWork.claimDueWork(RUNNER, 5, COPY_B);
    expect(held.map((item) => item.kind)).toEqual(["turn"]);
  });

  it("a channel between copies holds the turn queued until it reattaches", async () => {
    const { agentId } = await seedSandbox("turn-wait", {
      status: "running",
      containerRef: "ctr-1",
    });
    await seedQueuedTurn(agentId, "wait");
    expect(await dueWork.claimDueWork(RUNNER, 5, COPY_A)).toEqual([]);
    expect(await dueWork.claimDueWork(RUNNER, 5, COPY_B)).toEqual([]);
    expect(
      (await db.turn.findUnique({ where: { id: `${P}t-wait` } }))?.status,
    ).toBe("queued");
  });

  it("a dropped socket holds the work too: the copy that saw it close has nothing to send on", async () => {
    // The release keeps the copy recorded (so the reconciler can tell a
    // reconnecting sandbox from a gone one), but without a live connection
    // that copy must not be handed the sandbox's turns.
    const { agentId } = await seedSandbox("turn-dropped", {
      status: "running",
      containerRef: "ctr-1",
      channel: { replicaId: COPY_B, since: new Date() },
    });
    await seedQueuedTurn(agentId, "dropped");
    expect(await dueWork.claimDueWork(RUNNER, 5, COPY_B)).toEqual([]);
    expect(
      (await db.turn.findUnique({ where: { id: `${P}t-dropped` } }))?.status,
    ).toBe("queued");
  });

  it("the legacy path (no copy id) still claims every arm", async () => {
    const { agentId } = await seedSandbox("turn-legacy", {
      status: "running",
      containerRef: "ctr-1",
    });
    await seedQueuedTurn(agentId, "legacy");
    const claimed = await dueWork.claimDueWork(RUNNER, 5);
    expect(claimed.map((item) => item.kind)).toEqual(["turn"]);
  });

  it("aborts and home syncs are fenced to the holder too", async () => {
    const { id, agentId } = await seedSandbox("abort-sync", {
      status: "running",
      containerRef: "ctr-1",
      channel: { replicaId: COPY_B, connectionId: "conn-b" },
    });
    await db.sandbox.update({
      where: { id },
      data: { homeDesiredGeneration: 5, homeAppliedGeneration: 1 },
    });
    await db.conversation.create({
      data: { id: `${P}cv-abort`, agentId, source: "web" },
    });
    await db.turn.create({
      data: {
        id: `${P}t-abort`,
        conversationId: `${P}cv-abort`,
        message: "stop me",
        status: "running",
        abortRequested: true,
      },
    });

    expect(await dueWork.claimDueWork(RUNNER, 5, COPY_A)).toEqual([]);
    const kinds = (await dueWork.claimDueWork(RUNNER, 5, COPY_B))
      .map((item) => item.kind)
      .sort();
    expect(kinds).toEqual(["home.sync", "turn.abort"]);
  });

  it("starts go to a free copy, and a start claim takes ownership and clears the channel record", async () => {
    const { id } = await seedSandbox("start-any", {
      status: "unprovisioned",
      containerRef: "ctr-old",
      channel: { replicaId: COPY_B, connectionId: "old", tokenHash: HASH_1 },
    });

    const claimed = await dueWork.claimDueWork(RUNNER, 5, COPY_A);
    expect(claimed.map((item) => item.kind)).toEqual(["start"]);
    const row = await channelOf(id);
    expect(row?.status).toBe("starting");
    expect(row?.owner_replica_id).toBe(COPY_A);
    expect(row?.channel_replica_id).toBeNull();
    expect(row?.channel_connection_id).toBeNull();
    expect(row?.channel_token_hash).toBeNull();
    expect(row?.channel_since).toBeNull();
  });
});

describe.skipIf(!PROOF_URL)("the reconcile listing", () => {
  it("reports every channel state", async () => {
    const now = Date.now();
    await setReplicaSeen(COPY_B, new Date(now - 5 * 60 * 1000));
    const starting = await seedSandbox("st-starting", { status: "starting" });
    const awaiting = await seedSandbox("st-awaiting", {
      status: "starting",
      containerRef: "ctr-aw",
      channel: { tokenHash: HASH_1, since: new Date(now - 1000) },
    });
    const held = await seedSandbox("st-held", {
      status: "running",
      containerRef: "ctr-h",
      channel: { replicaId: COPY_A, connectionId: "c-h" },
    });
    const dropped = await seedSandbox("st-dropped", {
      status: "running",
      containerRef: "ctr-d",
      channel: { replicaId: COPY_A, since: new Date(now - 2000) },
    });
    const lost = await seedSandbox("st-lost", {
      status: "running",
      containerRef: "ctr-l",
      channel: { replicaId: COPY_B, connectionId: "c-l" },
    });
    const none = await seedSandbox("st-none", {
      status: "running",
      containerRef: "ctr-n",
    });

    const listing = await channels.listRunnerSandboxes(RUNNER, COPY_A);
    const stateOf = (id: string) => listing.channels[id]?.channel;
    expect(stateOf(starting.id)).toBe("starting");
    expect(stateOf(awaiting.id)).toBe("awaiting");
    expect(listing.channels[awaiting.id]?.containerRef).toBe("ctr-aw");
    expect(stateOf(held.id)).toBe("held");
    expect(stateOf(dropped.id)).toBe("dropped");
    expect(listing.channels[dropped.id]?.since).toBe(now - 2000);
    expect(stateOf(lost.id)).toBe("lost");
    expect(stateOf(none.id)).toBe("none");
  });

  it("the oldest live copy reconciles, and the next takes over when it dies", async () => {
    // The role read and the listing apply ONE rule. MUTATION-PROOF: give
    // the role read its own query (drop liveness, or order by id) and the
    // two disagree once the oldest copy stops heartbeating.
    const both = async (copy: string) => {
      const listed = (await channels.listRunnerSandboxes(RUNNER, copy))
        .reconciler;
      expect(await channels.isReconcilerReplica(RUNNER, copy)).toBe(listed);
      return listed;
    };
    expect(await both(COPY_A)).toBe(true);
    expect(await both(COPY_B)).toBe(false);

    await setReplicaSeen(COPY_A, new Date(Date.now() - 5 * 60 * 1000));
    expect(await both(COPY_B)).toBe(true);
    expect(await both(COPY_A)).toBe(false);
  });
});

describe.skipIf(!PROOF_URL)("reports about one container", () => {
  it("a stale observation never knocks down a newer container", async () => {
    const { id } = await seedSandbox("obs-stale", {
      status: "running",
      containerRef: "ctr-new",
    });
    await sandboxes.applyRunnerEvent(RUNNER, {
      kind: "sandbox.status",
      sandboxId: id,
      status: "stopped",
      observedContainerRef: "ctr-old",
    });
    expect((await channelOf(id))?.status).toBe("running");

    await sandboxes.applyRunnerEvent(RUNNER, {
      kind: "sandbox.status",
      sandboxId: id,
      status: "stopped",
      observedContainerRef: "ctr-new",
    });
    expect((await channelOf(id))?.status).toBe("stopped");
  });
});

describe.skipIf(!PROOF_URL)("the stray stop claim", () => {
  it("claims a parked sandbox's stray container and its lifecycle, never one a start or a live owner has", async () => {
    const { id } = await seedSandbox("stray", {
      status: "stopped",
      containerRef: "ctr-stray",
    });
    expect(await channels.claimStrayStop(RUNNER, COPY_A, id, "ctr-stray")).toBe(
      true,
    );
    const row = await channelOf(id);
    expect(row?.status).toBe("stopping");
    expect(row?.owner_replica_id).toBe(COPY_A);

    const { id: restarted } = await seedSandbox("stray-raced", {
      status: "starting",
      containerRef: "ctr-stray",
    });
    expect(
      await channels.claimStrayStop(RUNNER, COPY_A, restarted, "ctr-stray"),
    ).toBe(false);
    const { id: replaced } = await seedSandbox("stray-replaced", {
      status: "stopped",
      containerRef: "ctr-fresh",
    });
    expect(
      await channels.claimStrayStop(RUNNER, COPY_A, replaced, "ctr-stray"),
    ).toBe(false);
    const { id: owned } = await seedSandbox("stray-owned", {
      status: "failed",
      containerRef: "ctr-own",
      owner: COPY_B,
    });
    expect(
      await channels.claimStrayStop(RUNNER, COPY_A, owned, "ctr-own"),
    ).toBe(false);
    // Another runner's parked sandbox is never this runner's to stop.
    const { id: foreign } = await seedSandbox("stray-foreign", {
      status: "stopped",
      runnerId: OTHER_RUNNER,
      containerRef: "ctr-theirs",
    });
    expect(
      await channels.claimStrayStop(RUNNER, COPY_A, foreign, "ctr-theirs"),
    ).toBe(false);
    expect((await channelOf(foreign))?.status).toBe("stopped");
  });
});

describe.skipIf(!PROOF_URL)("lifecycle ownership", () => {
  it("a live owner keeps its sandbox's next lifecycle step from other copies", async () => {
    const { id } = await seedSandbox("own-live", {
      status: "unprovisioned",
      owner: COPY_A,
    });
    expect(await dueWork.claimDueWork(RUNNER, 5, COPY_B)).toEqual([]);
    expect((await channelOf(id))?.status).toBe("unprovisioned");

    const mine = await dueWork.claimDueWork(RUNNER, 5, COPY_A);
    expect(mine.map((item) => item.kind)).toEqual(["start"]);
  });

  it("a dead owner's sandbox passes to the next copy that claims it", async () => {
    const { id } = await seedSandbox("own-dead", {
      status: "unprovisioned",
      owner: COPY_A,
    });
    await setReplicaSeen(COPY_A, minutesAgo(5));

    const claimed = await dueWork.claimDueWork(RUNNER, 5, COPY_B);
    expect(claimed.map((item) => item.kind)).toEqual(["start"]);
    expect((await channelOf(id))?.owner_replica_id).toBe(COPY_B);
  });

  it("a restart stop is owner-fenced and takes ownership", async () => {
    const { id } = await seedSandbox("own-stop", {
      status: "running",
      containerRef: "ctr-1",
    });
    await db.sandbox.update({
      where: { id },
      data: { stopRequestedAt: new Date(), ownerReplicaId: COPY_B },
    });

    expect(await dueWork.claimDueWork(RUNNER, 5, COPY_A)).toEqual([]);
    await setReplicaSeen(COPY_B, minutesAgo(5));
    const claimed = await dueWork.claimDueWork(RUNNER, 5, COPY_A);
    expect(claimed.map((item) => item.kind)).toEqual(["stop"]);
    const row = await channelOf(id);
    expect(row?.status).toBe("stopping");
    expect(row?.owner_replica_id).toBe(COPY_A);
  });

  it("a single-process runner (no copy id) is unfenced and leaves ownership alone", async () => {
    const { id } = await seedSandbox("own-legacy", {
      status: "unprovisioned",
      owner: COPY_A,
    });
    const claimed = await dueWork.claimDueWork(RUNNER, 5);
    expect(claimed.map((item) => item.kind)).toEqual(["start"]);
    expect((await channelOf(id))?.owner_replica_id).toBe(COPY_A);
  });

  it("a start's own reports apply only from its owner", async () => {
    const { id } = await seedSandbox("own-report", {
      status: "starting",
      owner: COPY_B,
      containerRef: "ctr-new",
    });

    // Copy A lost ownership mid-start: its late failure and its container
    // ref must not overwrite copy B's start.
    await sandboxes.applyRunnerEvent(
      RUNNER,
      { kind: "sandbox.status", sandboxId: id, status: "failed", error: "x" },
      COPY_A,
    );
    await sandboxes.applyRunnerEvent(
      RUNNER,
      {
        kind: "sandbox.status",
        sandboxId: id,
        status: "starting",
        containerRef: "ctr-stale",
      },
      COPY_A,
    );
    let row = await channelOf(id);
    expect(row?.status).toBe("starting");
    expect(row?.container_ref).toBe("ctr-new");

    await sandboxes.applyRunnerEvent(
      RUNNER,
      { kind: "sandbox.status", sandboxId: id, status: "failed", error: "y" },
      COPY_B,
    );
    row = await channelOf(id);
    expect(row?.status).toBe("failed");
  });

  it("an observation about the current container lands from any copy", async () => {
    const { id } = await seedSandbox("own-observed", {
      status: "running",
      owner: COPY_B,
      containerRef: "ctr-o",
    });
    await sandboxes.applyRunnerEvent(
      RUNNER,
      {
        kind: "sandbox.status",
        sandboxId: id,
        status: "stopped",
        observedContainerRef: "ctr-o",
      },
      COPY_A,
    );
    expect((await channelOf(id))?.status).toBe("stopped");
  });

  it("supervisor.ready applies only from the copy holding the channel", async () => {
    const { id } = await seedSandbox("own-ready", {
      status: "starting",
      owner: COPY_A,
      containerRef: "ctr-1",
      channel: { replicaId: COPY_B, connectionId: "conn-b" },
    });
    await sandboxes.applyRunnerEvent(
      RUNNER,
      { kind: "supervisor.ready", sandboxId: id },
      COPY_A,
    );
    expect((await channelOf(id))?.status).toBe("starting");
    await sandboxes.applyRunnerEvent(
      RUNNER,
      { kind: "supervisor.ready", sandboxId: id },
      COPY_B,
    );
    expect((await channelOf(id))?.status).toBe("running");
  });

  it("a retired copy hands its sandboxes and the reconciler role over at once", async () => {
    const { id } = await seedSandbox("own-retire", {
      status: "unprovisioned",
      owner: COPY_A,
    });
    const held = await seedSandbox("own-retire-held", {
      status: "running",
      containerRef: "ctr-r",
      channel: { replicaId: COPY_A, connectionId: "conn-r" },
    });
    expect(await dueWork.claimDueWork(RUNNER, 5, COPY_B)).toEqual([]);
    expect(
      (await channels.listRunnerSandboxes(RUNNER, COPY_B)).reconciler,
    ).toBe(false);

    await channels.retireReplica(RUNNER, COPY_A);

    const claimed = await dueWork.claimDueWork(RUNNER, 5, COPY_B);
    expect(claimed.map((item) => item.kind)).toEqual(["start"]);
    expect((await channelOf(id))?.owner_replica_id).toBe(COPY_B);
    const listing = await channels.listRunnerSandboxes(RUNNER, COPY_B);
    expect(listing.reconciler).toBe(true);
    expect(await channels.isReconcilerReplica(RUNNER, COPY_B)).toBe(true);
    expect(await channels.isReconcilerReplica(RUNNER, COPY_A)).toBe(false);
    expect(listing.channels[held.id]?.channel).toBe("lost");
  });

  it("retiring is fenced to the caller's own runner", async () => {
    await channels.retireReplica(OTHER_RUNNER, COPY_A);
    expect(
      (await channels.listRunnerSandboxes(RUNNER, COPY_A)).reconciler,
    ).toBe(true);
    // The role is per runner: a copy of another runner is never this
    // runner's reconciler, whatever its age.
    expect(await channels.isReconcilerReplica(OTHER_RUNNER, COPY_A)).toBe(
      false,
    );
  });

  it("retiring is one-way: a retired copy's later calls never make it live again", async () => {
    // A copy keeps calling after it retires (socket releases, final
    // reports, a poll already in flight), and every call refreshes its
    // heartbeat. Liveness must not come back with it, or its sandboxes and
    // the reconciler role are stuck with a copy on its way out until the
    // window passes. MUTATION-PROOF: drop `retired_at IS NULL` from the
    // liveness rule.
    const { id } = await seedSandbox("own-retired-touched", {
      status: "unprovisioned",
      owner: COPY_A,
    });
    const held = await seedSandbox("held-retired-touched", {
      status: "running",
      containerRef: "ctr-t",
      channel: { replicaId: COPY_A, connectionId: "conn-t" },
    });
    // The other copy's poll is parked on the server: retiring wakes it, so
    // the handed-over start is claimed now, not at the next re-check.
    // MUTATION-PROOF: drop the signal.
    const parked = dueWork.waitForWork(5_000);
    await channels.retireReplica(RUNNER, COPY_A);
    expect(await parked).toBe(true);
    const retired = await db.runnerReplica.findUniqueOrThrow({
      where: { id: COPY_A },
      select: { retiredAt: true },
    });
    // The touch every authenticated call makes.
    await setReplicaSeen(COPY_A, new Date());

    const listing = await channels.listRunnerSandboxes(RUNNER, COPY_B);
    expect(listing.reconciler).toBe(true);
    // Its sockets read as lost from the moment it retired, never from its
    // later touches (which would keep pushing the reconciler's grace out)
    // nor from the dawn of time (which would report them dead at once).
    expect(listing.channels[held.id]).toMatchObject({
      channel: "lost",
      since: retired.retiredAt?.getTime(),
    });
    const claimed = await dueWork.claimDueWork(RUNNER, 5, COPY_B);
    expect(claimed.map((item) => item.kind)).toEqual(["start"]);
    expect((await channelOf(id))?.owner_replica_id).toBe(COPY_B);

    // Retiring again keeps the first moment: "lost since" never moves.
    await channels.retireReplica(RUNNER, COPY_A);
    expect(
      (
        await db.runnerReplica.findUniqueOrThrow({
          where: { id: COPY_A },
          select: { retiredAt: true },
        })
      ).retiredAt,
    ).toEqual(retired.retiredAt);
  });

  it("a retired copy is handed no new work, even work it would hold", async () => {
    // The Temporal lesson: a worker on its way out must get nothing new, or
    // the work sits on a process that is exiting until the stale windows.
    // Here: its own sandbox's next start, a turn for the socket it still
    // holds, and a stray's stop. MUTATION-PROOF: drop the retired gate from
    // `lifecycleFreeFor` (the start and the stray are claimed) or from
    // `channelHeldBy` (the turn is claimed).
    const held = await seedSandbox("retired-holds", {
      status: "running",
      containerRef: "ctr-h",
      owner: COPY_A,
      channel: { replicaId: COPY_A, connectionId: "conn-h" },
    });
    await seedQueuedTurn(held.agentId, "retired-holds");
    await seedSandbox("retired-owns", {
      status: "unprovisioned",
      owner: COPY_A,
    });
    const stray = await seedSandbox("retired-stray", {
      status: "stopped",
      containerRef: "ctr-s",
    });

    await channels.retireReplica(RUNNER, COPY_A);
    expect(await dueWork.claimDueWork(RUNNER, 5, COPY_A)).toEqual([]);
    expect(
      await channels.claimStrayStop(RUNNER, COPY_A, stray.id, "ctr-s"),
    ).toBe(false);
    // What the held poll asks to end early: only for its own runner's copy.
    expect(await channels.isReplicaRetired(RUNNER, COPY_A)).toBe(true);
    expect(await channels.isReplicaRetired(OTHER_RUNNER, COPY_A)).toBe(false);
    expect(await channels.isReplicaRetired(RUNNER, COPY_B)).toBe(false);

    // Control: the same work IS this copy's the moment it is not retired,
    // so the refusals above are the gate, not the seeds.
    await db.runnerReplica.update({
      where: { id: COPY_A },
      data: { retiredAt: null },
    });
    const claimed = await dueWork.claimDueWork(RUNNER, 5, COPY_A);
    expect(claimed.map((item) => item.kind).sort()).toEqual(["start", "turn"]);
    expect(
      await channels.claimStrayStop(RUNNER, COPY_A, stray.id, "ctr-s"),
    ).toBe(true);
  });
});

describe.skipIf(!PROOF_URL)("copy registration", () => {
  it("creates a copy row per registration and drops copies dead for a day", async () => {
    process.env.RUNNER_TOKEN = `rnr_${P}main`;
    const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db.runnerReplica.createMany({
      data: [
        {
          id: `${P}copy-dead`,
          runnerId: RUNNER,
          name: "dead",
          lastSeenAt: dayAgo,
        },
        // Another runner's dead copy is that runner's business.
        {
          id: `${P}copy-other-dead`,
          runnerId: OTHER_RUNNER,
          name: "other",
          lastSeenAt: dayAgo,
        },
      ],
    });

    const result = await runners.registerRunner({
      token: `rnr_${P}main`,
      name: "runner",
      capabilities: {
        maxSandboxes: 4,
        backend: "docker",
        homeDurability: "resident",
      },
      replicaName: "pod-1",
      portApiUrl: "http://10.0.1.7:8485",
    });
    expect(result.ok && result.replicaId).toBeTruthy();
    if (result.ok && result.replicaId) {
      // The copy's port-API address is recorded with it: the preview
      // route to whatever socket this copy comes to hold.
      const row = await db.runnerReplica.findUniqueOrThrow({
        where: { id: result.replicaId },
        select: { name: true, portApiUrl: true },
      });
      expect(row).toEqual({
        name: "pod-1",
        portApiUrl: "http://10.0.1.7:8485",
      });
    }
    const ids = (
      await db.runnerReplica.findMany({
        where: { runnerId: RUNNER },
        select: { id: true },
      })
    ).map((row) => row.id);
    expect(ids).not.toContain(`${P}copy-dead`);
    expect(ids).toContain(COPY_A);
    expect(
      await db.runnerReplica.count({ where: { id: `${P}copy-other-dead` } }),
    ).toBe(1);

    // A single-process runner registers without a copy, as before.
    const legacy = await runners.registerRunner({
      token: `rnr_${P}main`,
      name: "runner",
      capabilities: {
        maxSandboxes: 4,
        backend: "docker",
        homeDurability: "resident",
      },
    });
    expect(legacy).toEqual({ ok: true, runnerId: RUNNER });
  });
});
