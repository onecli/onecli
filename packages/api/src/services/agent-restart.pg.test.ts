import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * "Restart agent" on REAL PostgreSQL. The laws that make a restart actually
 * fresh live in SQL and across three services, so they are proven here, not
 * in a mock:
 *
 * - the reset reaches EVERY conversation of the agent and nothing else (a
 *   foreign workspace's agent is the planted negative control);
 * - in-flight turns end, queued ones stay deliverable;
 * - the running box is claimed for a stop AT ONCE, ahead of the idle window
 *   and keep-awake, and is handed no new turn meanwhile;
 * - a session ref the discarded boot reports late is NOT persisted (the
 *   race the restart exists to win), until the next start claim clears the
 *   flag and a fresh boot reports its own.
 *
 * Env-gated like the other proof suites; see pg-proof.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type DueWork = typeof import("./due-work");
type Agents = typeof import("./agent-service");
type Sandboxes = typeof import("./sandbox-service");
type Turns = typeof import("./turn-service");

let db: Db;
let dueWork: DueWork;
let agents: Agents;
let sandboxes: Sandboxes;
let turns: Turns;

const P = "rst-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const FOREIGN_WORKSPACE = `${P}ws-foreign`;
const RUNNER = `${P}runner`;
const OTHER_RUNNER = `${P}runner-other`;

const reset = async () => {
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
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

const seedAgent = async (
  suffix: string,
  opts: { workspaceId?: string; kind?: string } = {},
) => {
  const agent = await db.agent.create({
    data: {
      workspaceId: opts.workspaceId ?? WORKSPACE,
      name: `agent ${suffix}`,
      identifier: `${P}${suffix}`,
      accessToken: `aoc_${P}${suffix}`,
      kind: opts.kind ?? "hosted",
      harness: "jcode",
    },
    select: { id: true },
  });
  return agent.id;
};

/** A running sandbox that is BUSY by every ordinary measure: active a moment
 * ago (inside the idle window) and holding a live background process
 * (keep-awake). Only a restart may stop it now. */
const seedBusySandbox = async (suffix: string, agentId: string) => {
  const sandboxId = `${P}sb-${suffix}`;
  await db.sandbox.create({
    data: {
      id: sandboxId,
      agentId,
      runnerId: RUNNER,
      status: "running",
      lastActiveAt: new Date(),
      containerRef: `ctr-${suffix}`,
      homeAppliedGeneration: 1,
    },
  });
  await db.sandboxProcess.create({
    data: {
      sandboxId,
      ref: `proc-${suffix}`,
      containerRef: `ctr-${suffix}`,
      command: "sleep infinity",
      status: "running",
      startedAt: new Date(),
    },
  });
  return sandboxId;
};

const seedConversation = async (
  suffix: string,
  agentId: string,
  sessionRef: string | null,
) => {
  await db.conversation.create({
    data: {
      id: `${P}cv-${suffix}`,
      agentId,
      source: "web",
      externalRef: `${P}${suffix}`,
      harnessSessionRef: sessionRef,
    },
  });
  return `${P}cv-${suffix}`;
};

const seedTurn = async (
  suffix: string,
  conversationId: string,
  status: string,
) => {
  await db.turn.create({
    data: {
      id: `${P}t-${suffix}`,
      conversationId,
      message: suffix,
      status,
      ...(status === "running" && { startedAt: new Date() }),
    },
  });
  return `${P}t-${suffix}`;
};

const refOf = async (conversationId: string) =>
  (
    await db.conversation.findUnique({
      where: { id: conversationId },
      select: { harnessSessionRef: true },
    })
  )?.harnessSessionRef;

const turnOf = async (turnId: string) =>
  db.turn.findUnique({
    where: { id: turnId },
    select: { status: true, errorCode: true },
  });

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  // A long idle window: anything this suite sees stop, stopped because of
  // the restart, never because it idled out.
  process.env.SANDBOX_IDLE_STOP_SECONDS = "3600";

  ({ db } = await import("@onecli/db"));
  dueWork = await import("./due-work");
  agents = await import("./agent-service");
  sandboxes = await import("./sandbox-service");
  turns = await import("./turn-service");

  await reset();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.createMany({
    data: [
      { id: WORKSPACE, name: "Restart Workspace", organizationId: ORG },
      { id: FOREIGN_WORKSPACE, name: "Foreign Workspace", organizationId: ORG },
    ],
  });
});

beforeEach(async () => {
  if (!PROOF_URL) return;
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
  // Offline (no lastSeenAt): claiming is fenced by runner id, not liveness,
  // and an offline runner is invisible to placement for other suites.
  await db.runner.createMany({
    data: [
      { id: RUNNER, name: "runner", token: `rnr_${P}a`, capabilities: {} },
      {
        id: OTHER_RUNNER,
        name: "other",
        token: `rnr_${P}b`,
        capabilities: {},
      },
    ],
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.$disconnect();
});

describe.skipIf(!PROOF_URL)("restartAgent over real PostgreSQL", () => {
  it("resets every conversation of the agent, ends in-flight work, and fences nothing else", async () => {
    const agentId = await seedAgent("main");
    const sandboxId = await seedBusySandbox("main", agentId);
    const direct = await seedConversation("direct", agentId, "session_a");
    const slack = await seedConversation("slack", agentId, "session_b");
    const running = await seedTurn("running", direct, "running");
    const queued = await seedTurn("queued", slack, "queued");
    // Handed to the box but not started yet: it ends too, never re-sent
    // into the reset conversation, and in the restart's words (not "the
    // agent couldn't start": the person stopped it).
    const thirdConversation = await seedConversation("third", agentId, null);
    const dispatched = await seedTurn(
      "dispatched",
      thirdConversation,
      "dispatched",
    );
    // The planted negative control: another workspace's agent, same runner,
    // also mid-turn with a session to lose.
    const foreignId = await seedAgent("foreign", {
      workspaceId: FOREIGN_WORKSPACE,
    });
    await seedBusySandbox("foreign", foreignId);
    const foreignConversation = await seedConversation(
      "foreign",
      foreignId,
      "session_foreign",
    );
    const foreignTurn = await seedTurn(
      "foreign",
      foreignConversation,
      "running",
    );

    await agents.restartAgent(WORKSPACE, agentId);

    expect(await refOf(direct)).toBeNull();
    expect(await refOf(slack)).toBeNull();
    expect(await turnOf(running)).toEqual({
      status: "failed",
      errorCode: "agent_restarted",
    });
    expect(await turnOf(dispatched)).toEqual({
      status: "failed",
      errorCode: "agent_restarted",
    });
    expect(await turnOf(queued)).toEqual({ status: "queued", errorCode: null });
    const sandbox = await db.sandbox.findUnique({ where: { id: sandboxId } });
    expect(sandbox?.stopRequestedAt).toBeInstanceOf(Date);

    // Nothing of the foreign agent moved.
    expect(await refOf(foreignConversation)).toBe("session_foreign");
    expect(await turnOf(foreignTurn)).toEqual({
      status: "running",
      errorCode: null,
    });
    expect(
      (await db.sandbox.findUnique({ where: { id: `${P}sb-foreign` } }))
        ?.stopRequestedAt,
    ).toBeNull();
  });

  it("refuses an agent from another workspace (NOT_FOUND) and a BYO agent", async () => {
    const foreignId = await seedAgent("fenced", {
      workspaceId: FOREIGN_WORKSPACE,
    });
    await expect(agents.restartAgent(WORKSPACE, foreignId)).rejects.toThrow(
      "Agent not found",
    );
    const byoId = await seedAgent("byo", { kind: "byo" });
    await expect(agents.restartAgent(WORKSPACE, byoId)).rejects.toThrow(
      "Only hosted agents can be restarted",
    );
  });

  it("stops the busy box at once, dispatches nothing to it, and only its own runner claims it", async () => {
    const agentId = await seedAgent("claim");
    const sandboxId = await seedBusySandbox("claim", agentId);
    const conversation = await seedConversation("claim", agentId, "session_c");
    // A message sent right after the restart: it must wait for the fresh
    // boot, not run on the box being torn down.
    await agents.restartAgent(WORKSPACE, agentId);
    await seedTurn("after", conversation, "queued");

    // Positive control for the fence: the same busy box, NOT restarted, is
    // neither stopped (idle window, keep-awake) nor starved of its turn.
    const controlId = await seedAgent("control");
    await seedBusySandbox("control", controlId);
    const controlConversation = await seedConversation(
      "control",
      controlId,
      "session_ctl",
    );
    await seedTurn("control", controlConversation, "queued");

    expect(await dueWork.claimDueWork(OTHER_RUNNER, 10)).toEqual([]);

    const claimed = await dueWork.claimDueWork(RUNNER, 10);
    expect(claimed.map((item) => [item.kind, item.sandboxId]).sort()).toEqual(
      [
        ["stop", sandboxId],
        ["turn", `${P}sb-control`],
      ].sort(),
    );
    expect(
      (await db.sandbox.findUnique({ where: { id: sandboxId } }))?.status,
    ).toBe("stopping");
    // Claimed once: the next poll has nothing more for this box.
    expect(
      (await dueWork.claimDueWork(RUNNER, 10)).filter(
        (item) => item.sandboxId === sandboxId,
      ),
    ).toEqual([]);
  });

  it("hands no turn to a restarted box whose stop has not been claimed yet", async () => {
    // The window the turn-arm fence exists for: a runner whose lifecycle
    // budget is spent (limit 0 here) claims turns from their own budget, so
    // the restarted box is still `running` when a new message is due.
    const agentId = await seedAgent("window");
    const sandboxId = await seedBusySandbox("window", agentId);
    const conversation = await seedConversation("window", agentId, null);
    await agents.restartAgent(WORKSPACE, agentId);
    await seedTurn("window", conversation, "queued");

    expect(await dueWork.claimDueWork(RUNNER, 0)).toEqual([]);
    expect(
      (await db.sandbox.findUnique({ where: { id: sandboxId } }))?.status,
    ).toBe("running");
    expect(await turnOf(`${P}t-window`)).toEqual({
      status: "queued",
      errorCode: null,
    });
  });

  it("keeps the discarded boot's late session ref out, then a fresh boot's in", async () => {
    const agentId = await seedAgent("race");
    const sandboxId = await seedBusySandbox("race", agentId);
    const conversation = await seedConversation("race", agentId, "session_old");
    const turnId = await seedTurn("race", conversation, "running");
    const reporter = { runnerId: RUNNER, sandboxId };

    await agents.restartAgent(WORKSPACE, agentId);

    // The old boot finishes the turn the restart already failed, and reports
    // the session it was holding: the late-report salvage must not keep it.
    await turns.finishTurn({
      reporter,
      conversationId: conversation,
      turnId,
      status: "done",
      sessionRef: "session_old",
    });
    expect(await refOf(conversation)).toBeNull();

    // The won-close twin: a turn the old boot was still holding (it reached
    // `running` before the restart's strand) closes on that boot. Even a
    // close the control plane ACCEPTS keeps the discarded ref out.
    const lateTurn = await seedTurn("late", conversation, "running");
    await turns.finishTurn({
      reporter,
      conversationId: conversation,
      turnId: lateTurn,
      status: "done",
      sessionRef: "session_old",
    });
    expect(await refOf(conversation)).toBeNull();

    // The box stops and the next message starts a fresh boot: the start
    // claim clears the restart, and that boot's own ref is kept again.
    await dueWork.claimDueWork(RUNNER, 10);
    await sandboxes.applyRunnerEvent(RUNNER, {
      kind: "sandbox.status",
      sandboxId,
      status: "stopped",
    });
    await db.sandbox.updateMany({
      where: { id: sandboxId, status: "stopped" },
      data: { status: "unprovisioned" },
    });
    const freshTurn = await seedTurn("fresh", conversation, "queued");
    const started = await dueWork.claimDueWork(RUNNER, 10);
    expect(started.some((item) => item.kind === "start")).toBe(true);
    expect(
      (await db.sandbox.findUnique({ where: { id: sandboxId } }))
        ?.stopRequestedAt,
    ).toBeNull();

    await db.turn.update({
      where: { id: freshTurn },
      data: { status: "running", startedAt: new Date() },
    });
    await turns.finishTurn({
      reporter,
      conversationId: conversation,
      turnId: freshTurn,
      status: "done",
      sessionRef: "session_fresh",
    });
    expect(await refOf(conversation)).toBe("session_fresh");
  });
});
