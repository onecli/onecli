import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";
import { MODEL_PROVIDER_ERROR_MESSAGE } from "../validations/conversation.js";

/**
 * Scheduled tasks on REAL PostgreSQL (step 7). What only pg can prove:
 * the claim's `FOR UPDATE SKIP LOCKED` under concurrency, the lease CAS
 * against a concurrent human edit, the fire path composing through the real
 * conversation/turn machinery (door-1 included), the settle path's delivery
 * materialization and exactly-once, the auto-disable counters, and the
 * continuity bridge reading real transcript rows.
 *
 * Env-gated like the other proof suites; see pg-proof.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type DueWork = typeof import("./due-work");
type CronFire = typeof import("./cron-fire-service");
type TurnService = typeof import("./turn-service");
type TurnContext = typeof import("./turn-context-service");
type ConversationService = typeof import("./conversation-service");
type PlatformTools = typeof import("./platform-tool-service");

let db: Db;
let dueWork: DueWork;
let cronFire: CronFire;
let turnService: TurnService;
let turnContext: TurnContext;
let conversationService: ConversationService;
let platformTools: PlatformTools;

const P = "cron-";
const ORG = `${P}org`;
const WORKSPACE = `${P}proj`;
const FOREIGN_ORG = `${P}forg`;
const FOREIGN_WORKSPACE = `${P}fproj`;
const RUNNER_A = `${P}runner-a`;
const RUNNER_B = `${P}runner-b`;
const USER = `${P}user`;

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  // Pinned per-suite: process.env leaks across worker files, and CI's ambient
  // NEXT_PUBLIC_EDITION is cloud — these assertions are flat-team semantics.
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  // The sweep-settle test ages a run against THIS value, not the prod default.
  process.env.TURN_CEILING_SECONDS = "1800";

  ({ db } = await import("@onecli/db"));
  dueWork = await import("./due-work");
  cronFire = await import("./cron-fire-service");
  turnService = await import("./turn-service");
  turnContext = await import("./turn-context-service");
  conversationService = await import("./conversation-service");
  platformTools = await import("./platform-tool-service");

  await resetAll();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "Cron Workspace", organizationId: ORG },
  });
  await db.organization.create({
    data: { id: FOREIGN_ORG, name: FOREIGN_ORG, slug: FOREIGN_ORG },
  });
  await db.workspace.create({
    data: {
      id: FOREIGN_WORKSPACE,
      name: "Foreign Workspace",
      organizationId: FOREIGN_ORG,
    },
  });
  await db.user.create({
    data: {
      id: USER,
      email: `${P}user@example.com`,
      name: "Cron User",
      externalAuthId: `${P}auth`,
    },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await resetAll();
});

const resetAll = async () => {
  await db.agentCron.deleteMany({ where: { name: { startsWith: P } } });
  await db.turnEvent.deleteMany({
    where: { conversation: { agent: { identifier: { startsWith: P } } } },
  });
  await db.turn.deleteMany({
    where: { conversation: { agent: { identifier: { startsWith: P } } } },
  });
  await db.conversation.deleteMany({
    where: { agent: { identifier: { startsWith: P } } },
  });
  await db.policyRuleV2.deleteMany({ where: { name: { startsWith: P } } });
  await db.secret.deleteMany({ where: { name: { startsWith: P } } });
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
  // The tool-service audits agent-authored writes under the creator, and
  // audit rows pin their user — clear them before the user can go.
  await db.auditLog.deleteMany({ where: { userId: USER } });
  await db.user.deleteMany({ where: { id: USER } });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

beforeEach(async () => {
  if (!PROOF_URL) return;
  await db.agentCron.deleteMany({ where: { name: { startsWith: P } } });
  await db.turnEvent.deleteMany({
    where: { conversation: { agent: { identifier: { startsWith: P } } } },
  });
  await db.turn.deleteMany({
    where: { conversation: { agent: { identifier: { startsWith: P } } } },
  });
  await db.conversation.deleteMany({
    where: { agent: { identifier: { startsWith: P } } },
  });
  await db.policyRuleV2.deleteMany({ where: { name: { startsWith: P } } });
  await db.secret.deleteMany({ where: { name: { startsWith: P } } });
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
  await db.user.upsert({
    where: { id: USER },
    update: {},
    create: {
      id: USER,
      email: `${P}user@example.com`,
      name: "Cron User",
      externalAuthId: `${P}auth`,
    },
  });
  // Offline on purpose (see due-work.pg.test.ts): claiming is fenced by
  // runner id, not liveness, and offline runners are invisible to placement.
  await db.runner.createMany({
    data: [
      { id: RUNNER_A, name: "runner a", token: `rnr_${P}a` },
      { id: RUNNER_B, name: "runner b", token: `rnr_${P}b` },
    ],
  });
});

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

/** Door-1 pass: an injectable LLM key, seeded the way the product does it. */
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

const seedSandbox = async (suffix: string, agentId: string, status: string) => {
  await db.sandbox.create({
    data: { id: `${P}sb-${suffix}`, agentId, runnerId: RUNNER_A, status },
  });
  return `${P}sb-${suffix}`;
};

/** A cron whose next fire is already in the past. */
const seedDueCron = async (
  agentId: string,
  suffix: string,
  overrides: {
    enabled?: boolean;
    originConversationId?: string | null;
    createdByUserId?: string | null;
    consecutiveFailures?: number;
    nextFireAt?: Date;
  } = {},
) => {
  const cron = await db.agentCron.create({
    data: {
      agentId,
      name: `${P}${suffix}`,
      prompt: `do the ${suffix} thing`,
      schedule: "*/5 * * * *",
      timezone: "UTC",
      enabled: overrides.enabled ?? true,
      nextFireAt: overrides.nextFireAt ?? new Date(Date.now() - 60_000),
      originConversationId: overrides.originConversationId ?? null,
      createdByUserId: overrides.createdByUserId ?? null,
      consecutiveFailures: overrides.consecutiveFailures ?? 0,
    },
    select: { id: true },
  });
  return cron.id;
};

describe.skipIf(!PROOF_URL)("claiming due crons", () => {
  it("claims a due cron exactly once under two concurrent pollers", async () => {
    const agentId = await seedAgent("claim-once");
    await seedDueCron(agentId, "claim-once");

    const [a, b] = await Promise.all([
      dueWork.claimDueCrons(),
      dueWork.claimDueCrons(),
    ]);
    // SKIP LOCKED plus the lease stamp: one poller gets it, the other sees
    // nothing due — never both.
    expect(a.crons.length + b.crons.length).toBe(1);
  });

  it("never claims disabled or not-yet-due schedules, and respects the fire limit", async () => {
    const agentId = await seedAgent("claim-limit");
    await seedDueCron(agentId, "disabled", { enabled: false });
    await seedDueCron(agentId, "future", {
      nextFireAt: new Date(Date.now() + 3_600_000),
    });
    for (let i = 0; i < 12; i += 1) {
      await seedDueCron(agentId, `due-${i}`);
    }

    const { crons } = await dueWork.claimDueCrons();
    expect(crons.length).toBe(dueWork.CRON_FIRE_LIMIT);
    expect(crons.every((cron) => cron.name.startsWith(`${P}due-`))).toBe(true);
  });

  it("the lease CAS loses to a concurrent human edit — the fire is skipped, not run stale", async () => {
    const agentId = await seedAgent("cas");
    const cronId = await seedDueCron(agentId, "cas");

    const { lease, crons } = await dueWork.claimDueCrons();
    expect(crons).toHaveLength(1);

    // A human PATCH lands between the claim and the advance: the service
    // recomputes next_fire_at, so the stored value no longer matches OUR
    // lease. MUTATION-PROOF: drop the nextFireAt filter from
    // advanceClaimedCron's where and this fails.
    await db.agentCron.update({
      where: { id: cronId },
      data: { nextFireAt: new Date(Date.now() + 999_000) },
    });

    const advanced = await dueWork.advanceClaimedCron(
      cronId,
      lease,
      new Date(Date.now() + 300_000),
    );
    expect(advanced).toBe(false);
  });
});

describe.skipIf(!PROOF_URL)("the schedule cap", () => {
  it("refuses the 21st schedule — the availability bound from the security review", async () => {
    // MUTATION-PROOF: drop the count check from createCron and this fails.
    const agentId = await seedAgent("cap");
    await db.agentCron.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        agentId,
        name: `${P}cap-${i}`,
        prompt: "p",
        schedule: "0 9 * * *",
        timezone: "UTC",
        nextFireAt: new Date(Date.now() + 3_600_000),
      })),
    });
    const cronService = await import("./agent-cron-service");
    await expect(
      cronService.createCron(
        WORKSPACE,
        agentId,
        {
          name: `${P}cap-over`,
          prompt: "p",
          schedule: "0 9 * * *",
          timezone: "UTC",
        },
        { originConversationId: null, createdByUserId: null },
      ),
    ).rejects.toThrow(/already has 20 schedules/);
  });
});

describe.skipIf(!PROOF_URL)("one-shot schedules", () => {
  /** An ISO local datetime (croner's fire-once pattern) already in the past,
   * armed due — the exact shape that used to wedge the fire loop forever. */
  const seedDueOneShot = async (agentId: string, suffix: string) => {
    const occurrence = new Date(Date.now() - 120_000);
    const cron = await db.agentCron.create({
      data: {
        agentId,
        name: `${P}${suffix}`,
        prompt: `do the ${suffix} thing once`,
        schedule: occurrence.toISOString().slice(0, 19),
        timezone: "UTC",
        nextFireAt: new Date(Date.now() - 60_000),
      },
      select: { id: true },
    });
    return cron.id;
  };

  it("fires exactly once, completes the row, and is NEVER re-claimed", async () => {
    // MUTATION-PROOF both ways: revert the fireOne branch (throwing
    // computeNextFire) and the first fire creates no turn; drop the
    // completing CAS and the later polls re-claim and re-fire.
    const agentId = await seedAgent("once");
    await grantLlmKey(agentId, "once-key");
    const cronId = await seedDueOneShot(agentId, "once");

    expect(await cronFire.fireDueCrons()).toBe(1);

    const conversation = await db.conversation.findFirstOrThrow({
      where: { agentId, source: "cron", externalRef: cronId },
      select: { id: true },
    });
    const turns = await db.turn.findMany({
      where: { conversationId: conversation.id },
      select: { status: true, source: true },
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.source).toBe("cron");

    const cron = await db.agentCron.findUniqueOrThrow({
      where: { id: cronId },
      select: { enabled: true, disabledReason: true, lastFiredAt: true },
    });
    expect(cron.enabled).toBe(false);
    expect(cron.disabledReason).toBe("completed");
    expect(cron.lastFiredAt).not.toBeNull();

    // The forever-reclaim regression pin: further polls claim NOTHING and
    // no second turn ever appears.
    expect(await cronFire.fireDueCrons()).toBe(0);
    expect(await cronFire.fireDueCrons()).toBe(0);
    expect(
      await db.turn.count({ where: { conversationId: conversation.id } }),
    ).toBe(1);
  });

  it("completed one-shots do not count against the schedule cap", async () => {
    const agentId = await seedAgent("once-cap");
    await db.agentCron.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        agentId,
        name: `${P}once-cap-${i}`,
        prompt: "p",
        schedule: i === 0 ? "2026-01-01T09:00:00" : "0 9 * * *",
        timezone: "UTC",
        nextFireAt: new Date(Date.now() + 3_600_000),
        ...(i === 0 && { enabled: false, disabledReason: "completed" }),
      })),
    });
    const cronService = await import("./agent-cron-service");
    const created = await cronService.createCron(
      WORKSPACE,
      agentId,
      {
        name: `${P}once-cap-new`,
        prompt: "p",
        schedule: "0 10 * * *",
        timezone: "UTC",
      },
      { originConversationId: null, createdByUserId: null },
    );
    expect(created.id).toBeTruthy();
  });

  it("run-now on a completed one-shot reads the honest refusal", async () => {
    const agentId = await seedAgent("once-run");
    const cron = await db.agentCron.create({
      data: {
        agentId,
        name: `${P}once-run`,
        prompt: "p",
        schedule: "2026-01-01T09:00:00",
        timezone: "UTC",
        nextFireAt: new Date(),
        enabled: false,
        disabledReason: "completed",
      },
      select: { id: true },
    });
    const cronService = await import("./agent-cron-service");
    await expect(
      cronService.runCronNow(WORKSPACE, agentId, cron.id),
    ).rejects.toThrow(/already ran to completion/);
  });
});

describe.skipIf(!PROOF_URL)("firing", () => {
  it("a fire is a real turn in the cron's own conversation, and it wakes the parked sandbox", async () => {
    const agentId = await seedAgent("fire");
    await grantLlmKey(agentId, "fire-key");
    const sandboxId = await seedSandbox("fire", agentId, "stopped");
    const cronId = await seedDueCron(agentId, "fire");

    const fired = await cronFire.fireDueCrons();
    expect(fired).toBe(1);

    const conversation = await db.conversation.findFirstOrThrow({
      where: { agentId, source: "cron", externalRef: cronId },
      select: { id: true, title: true, direct: true, userId: true },
    });
    expect(conversation.direct).toBe(false);
    expect(conversation.userId).toBeNull();
    expect(conversation.title).toBe(`${P}fire`);

    const turn = await db.turn.findFirstOrThrow({
      where: { conversationId: conversation.id },
      select: { status: true, source: true, userId: true, message: true },
    });
    expect(turn.status).toBe("queued");
    expect(turn.source).toBe("cron");
    expect(turn.userId).toBeNull();
    // The scheduled-run header wraps the stored prompt.
    expect(turn.message).toContain('[Scheduled run "');
    expect(turn.message).toContain("do the fire thing");

    const sandbox = await db.sandbox.findUniqueOrThrow({
      where: { id: sandboxId },
      select: { status: true },
    });
    expect(sandbox.status).toBe("unprovisioned");

    const cron = await db.agentCron.findUniqueOrThrow({
      where: { id: cronId },
      select: { nextFireAt: true, lastFiredAt: true },
    });
    expect(cron.nextFireAt.getTime()).toBeGreaterThan(Date.now());
    expect(cron.lastFiredAt).not.toBeNull();
  });

  it("a fire onto a still-running previous run records skipped_busy and does not count as failure", async () => {
    const agentId = await seedAgent("busy");
    await grantLlmKey(agentId, "busy-key");
    await seedSandbox("busy", agentId, "running");
    const cronId = await seedDueCron(agentId, "busy");

    await cronFire.fireDueCrons();
    // Re-arm and fire again while the first turn is still queued/active.
    await db.agentCron.update({
      where: { id: cronId },
      data: { nextFireAt: new Date(Date.now() - 1000) },
    });
    await cronFire.fireDueCrons();

    const cron = await db.agentCron.findUniqueOrThrow({
      where: { id: cronId },
      select: { lastOutcome: true, consecutiveFailures: true, enabled: true },
    });
    expect(cron.lastOutcome).toBe("skipped_busy");
    expect(cron.consecutiveFailures).toBe(0);
    expect(cron.enabled).toBe(true);

    const turns = await db.turn.count({
      where: { conversation: { agentId } },
    });
    expect(turns).toBe(1);
  });

  it("a keyless agent's fire fails at door 1 and counts toward the failure disable", async () => {
    const agentId = await seedAgent("keyless");
    await seedSandbox("keyless", agentId, "stopped");
    const cronId = await seedDueCron(agentId, "keyless", {
      consecutiveFailures: 4,
    });

    await cronFire.fireDueCrons();

    const turn = await db.turn.findFirstOrThrow({
      where: { conversation: { agentId } },
      select: { status: true, errorCode: true },
    });
    expect(turn.status).toBe("failed");
    expect(turn.errorCode).toBe("no_model_key");

    // Fifth consecutive failure: the schedule turns itself off with a reason.
    const cron = await db.agentCron.findUniqueOrThrow({
      where: { id: cronId },
      select: {
        enabled: true,
        disabledReason: true,
        consecutiveFailures: true,
      },
    });
    expect(cron.enabled).toBe(false);
    expect(cron.disabledReason).toBe("failures");
    expect(cron.consecutiveFailures).toBe(5);
  });
});

describe.skipIf(!PROOF_URL)("settling and delivery", () => {
  const fireAndGetRun = async (suffix: string) => {
    const agentId = await seedAgent(suffix);
    await grantLlmKey(agentId, `${suffix}-key`);
    const sandboxId = await seedSandbox(suffix, agentId, "running");
    const origin = await conversationService.ensureDirectConversation(
      WORKSPACE,
      agentId,
      USER,
    );
    const cronId = await seedDueCron(agentId, suffix, {
      originConversationId: origin.id,
      createdByUserId: USER,
    });
    await cronFire.fireDueCrons();
    const run = await db.turn.findFirstOrThrow({
      where: { conversation: { agentId, source: "cron" } },
      select: { id: true, conversationId: true },
    });
    // The reporter fence needs dispatched/running, and the answer extraction
    // reads the run's text event — write both the way the runner would.
    await db.turn.update({
      where: { id: run.id },
      data: { status: "running" },
    });
    const conversation = await db.conversation.update({
      where: { id: run.conversationId },
      data: { lastSeq: { increment: 1 } },
      select: { lastSeq: true },
    });
    await db.turnEvent.create({
      data: {
        conversationId: run.conversationId,
        turnId: run.id,
        seq: conversation.lastSeq,
        type: "text",
        payload: { type: "text", text: `the ${suffix} report body` },
      },
    });
    return { agentId, sandboxId, cronId, run, originId: origin.id };
  };

  it("a finished run delivers ONE report turn to the origin conversation, exactly once", async () => {
    const { sandboxId, cronId, run, originId } = await fireAndGetRun("settle");

    const finish = () =>
      turnService.finishTurn({
        reporter: { sandboxId, runnerId: RUNNER_A },
        conversationId: run.conversationId,
        turnId: run.id,
        status: "done",
      });
    await finish();
    // A late duplicate report (the stale-dispatch window) must not deliver
    // twice — the fenced status transition is the exactly-once gate.
    // MUTATION-PROOF: move the delivery before the transition and this fails.
    await finish();

    const deliveries = await db.turn.findMany({
      where: { conversationId: originId, source: "cron" },
      select: { status: true, userId: true, message: true, id: true },
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status).toBe("done");
    expect(deliveries[0]!.userId).toBeNull();
    expect(deliveries[0]!.message).toContain(`Scheduled run "${P}settle"`);

    const text = await db.turnEvent.findFirstOrThrow({
      where: { turnId: deliveries[0]!.id, type: "text" },
      select: { payload: true, seq: true },
    });
    expect((text.payload as { text: string }).text).toContain(
      "the settle report body",
    );

    // The delivery ANNOUNCES itself: a terminal event right after the text,
    // contiguous seq — this is what tells a live client (whose new-turn
    // signal is the boundary set) that a delivery row exists and is done.
    // MUTATION-PROOF: drop the turn.done write in the materializer and this
    // fails; break the seq discipline and the contiguity check fails.
    const done = await db.turnEvent.findFirstOrThrow({
      where: { turnId: deliveries[0]!.id, type: "turn.done" },
      select: { seq: true },
    });
    expect(done.seq).toBe(text.seq + 1);

    const cron = await db.agentCron.findUniqueOrThrow({
      where: { id: cronId },
      select: { lastOutcome: true, consecutiveFailures: true },
    });
    expect(cron.lastOutcome).toBe("ok");
    expect(cron.consecutiveFailures).toBe(0);
  });

  it("a ceiling-swept run still settles: outcome, strike, and the delivery", async () => {
    // The sweep's raw UPDATE bypasses finishTurn (whose late real report is
    // a fenced no-op), so the sweep's returned rows are the ONLY settle
    // chance — this is the route's pairing, verbatim. Without it, a
    // ceiling-killed schedule showed a stale lastOutcome forever and never
    // counted a strike.
    const { cronId, run, originId } = await fireAndGetRun("sweep-settle");
    // Started, so the sweep files it under the time-limit copy (a
    // never-started run gets the start-failure arm instead).
    await db.turn.update({
      where: { id: run.id },
      data: { startedAt: new Date() },
    });
    await db.$executeRaw`UPDATE turns SET created_at = now() - interval '40 minutes' WHERE id = ${run.id}`;

    await turnService.settleSweptTurns(await dueWork.reclaimStaleTurns());

    const cron = await db.agentCron.findUniqueOrThrow({
      where: { id: cronId },
      select: { lastOutcome: true, consecutiveFailures: true },
    });
    expect(cron.lastOutcome).toBe("failed");
    expect(cron.consecutiveFailures).toBe(1);

    const delivery = await db.turn.findFirstOrThrow({
      where: { conversationId: originId, source: "cron" },
      select: { id: true },
    });
    const text = await db.turnEvent.findFirstOrThrow({
      where: { turnId: delivery.id, type: "text" },
      select: { payload: true },
    });
    expect((text.payload as { text: string }).text).toContain("time limit");

    // And the sweep flagged the orphan for the abort claim arm's failed leg.
    const row = await db.turn.findUniqueOrThrow({
      where: { id: run.id },
      select: { abortRequested: true, errorCode: true, status: true },
    });
    expect(row.status).toBe("failed");
    expect(row.errorCode).toBe("turn_time_limit");
    expect(row.abortRequested).toBe(true);
  });

  it("a failed run delivers the failure and counts toward auto-disable", async () => {
    const { sandboxId, cronId, run, originId } = await fireAndGetRun("fail");

    await turnService.finishTurn({
      reporter: { sandboxId, runnerId: RUNNER_A },
      conversationId: run.conversationId,
      turnId: run.id,
      status: "failed",
      error: "the model exploded",
    });

    const delivery = await db.turn.findFirstOrThrow({
      where: { conversationId: originId, source: "cron" },
      select: { id: true },
    });
    const text = await db.turnEvent.findFirstOrThrow({
      where: { turnId: delivery.id, type: "text" },
      select: { payload: true },
    });
    expect((text.payload as { text: string }).text).toContain(
      "the model exploded",
    );

    const cron = await db.agentCron.findUniqueOrThrow({
      where: { id: cronId },
      select: { lastOutcome: true, consecutiveFailures: true, enabled: true },
    });
    expect(cron.lastOutcome).toBe("failed");
    expect(cron.consecutiveFailures).toBe(1);
    expect(cron.enabled).toBe(true);
  });

  it("a coded provider refusal delivers the CANONICAL copy, never the raw blob", async () => {
    // The automation delivery is the third user-facing surface (after web
    // and Slack): a known failure code must substitute the canonical
    // sentence there too — the raw provider response is operator material.
    const { sandboxId, run, originId } = await fireAndGetRun("fail-coded");

    await turnService.finishTurn({
      reporter: { sandboxId, runnerId: RUNNER_A },
      conversationId: run.conversationId,
      turnId: run.id,
      status: "failed",
      error:
        'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit reached"}}',
      errorCode: "model_provider_error",
    });

    const delivery = await db.turn.findFirstOrThrow({
      where: { conversationId: originId, source: "cron" },
      select: { id: true },
    });
    const text = await db.turnEvent.findFirstOrThrow({
      where: { turnId: delivery.id, type: "text" },
      select: { payload: true },
    });
    expect((text.payload as { text: string }).text).toContain(
      MODEL_PROVIDER_ERROR_MESSAGE,
    );
    expect((text.payload as { text: string }).text).not.toContain(
      "rate_limit_error",
    );
  });

  it("an invisible cold-death revival never counts toward auto-disable", async () => {
    // A harness that dies before the scheduled run STARTED is the platform's
    // hiccup, not the schedule's: the revival returns before the automation
    // settle, so no strike, no delivery, no outcome. MUTATION-PROOF: let the
    // revived path fall through to settleAutomationRun and the strike
    // assertion fails.
    const { cronId, sandboxId, run, originId } =
      await fireAndGetRun("cold-revive");
    // The exact cold-death shape: handed over, never started.
    await db.turn.update({
      where: { id: run.id },
      data: { status: "dispatched", startedAt: null },
    });

    await turnService.finishTurn({
      reporter: { sandboxId, runnerId: RUNNER_A },
      conversationId: run.conversationId,
      turnId: run.id,
      status: "failed",
      error: "harness launch failed: Error: spawn ENOENT",
      errorCode: "agent_start_failed",
    });

    const revived = await db.turn.findUniqueOrThrow({
      where: { id: run.id },
      select: { status: true, retriedAt: true, error: true },
    });
    expect(revived.status).toBe("queued");
    expect(revived.retriedAt).not.toBeNull();
    expect(revived.error).toBeNull();

    const cron = await db.agentCron.findUniqueOrThrow({
      where: { id: cronId },
      select: { consecutiveFailures: true, lastOutcome: true },
    });
    expect(cron.consecutiveFailures).toBe(0);
    expect(cron.lastOutcome).not.toBe("failed");
    // And nothing was delivered — the run has not ended.
    expect(
      await db.turn.count({
        where: { conversationId: originId, source: "cron" },
      }),
    ).toBe(0);
  });

  it("the continuity bridge rides the dispatch CONTEXT, never the stored message — and only for the message right after a delivery", async () => {
    const { agentId, sandboxId, run, originId } = await fireAndGetRun("bridge");
    await turnService.finishTurn({
      reporter: { sandboxId, runnerId: RUNNER_A },
      conversationId: run.conversationId,
      turnId: run.id,
      status: "done",
    });

    // The user reacts to the report that just landed. Their turn is stored
    // VERBATIM — the bridge is NOT in the message (the chat/Slack render this).
    // MUTATION-PROOF: restore the createTurn prefix and this exact-match fails.
    const first = await turnService.createTurn(
      WORKSPACE,
      originId,
      "what was that?",
      { source: "web", userId: USER },
    );
    expect(first.message).toBe("what was that?");

    // The bridge rides the delivery-only context instead (composed at
    // dispatch). MUTATION-PROOF: drop the human-gated bridge from
    // buildTurnContext and the report vanishes from the context.
    const context = await turnContext.buildTurnContext(
      agentId,
      originId,
      first.id,
      first.message,
    );
    expect(context).toContain("[Context from your automated runs");
    expect(context).toContain("the bridge report body");

    // Their NEXT message has no new deliveries behind it — no bridge, in the
    // message OR the context.
    await db.turn.update({
      where: { id: first.id },
      data: { status: "done", finishedAt: new Date() },
    });
    const second = await turnService.createTurn(
      WORKSPACE,
      originId,
      "thanks!",
      {
        source: "web",
        userId: USER,
      },
    );
    expect(second.message).toBe("thanks!");
    const secondContext = await turnContext.buildTurnContext(
      agentId,
      originId,
      second.id,
      second.message,
    );
    expect(secondContext ?? "").not.toContain("the bridge report body");
  });

  it("never relays a FAILED automation run — a run that produced no report is not context", async () => {
    // THE LIVE FAILURE (2026-08-31). A watch wake died on a model 401, so its
    // `text` event never landed. The bridge selected it anyway (source +
    // time only), and with an empty body what reached the model was the run's
    // own INSTRUCTION — which it answered in the next human turn, reading as
    // unprompted noise about background tasks nobody asked about.
    //
    // MUTATION-PROOF: drop `status: "done"` from the deliveries query and the
    // failed run's instruction comes back.
    const { agentId, originId } = await fireAndGetRun("failbridge");

    // A delivery that FAILED: materialized into the origin like a real one,
    // but terminal-failed with no text event — exactly the live shape.
    await db.conversation.update({
      where: { id: originId },
      data: { lastSeq: { increment: 1 } },
    });
    await db.turn.create({
      data: {
        conversationId: originId,
        message:
          "[Platform wake: 3 background task(s) you were watching finished]\n\nCheck each outcome and report it.",
        status: "failed",
        source: "watch",
        userId: null,
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    });

    const asked = await turnService.createTurn(
      WORKSPACE,
      originId,
      "hey how are you",
      { source: "web", userId: USER },
    );
    const context = await turnContext.buildTurnContext(
      agentId,
      originId,
      asked.id,
      asked.message,
    );

    // Nothing to relay → no bridge block at all.
    expect(context ?? "").not.toContain("Platform wake");
    expect(context ?? "").not.toContain("Check each outcome");
    expect(context ?? "").not.toContain("[Context from your automated runs");
  });

  it("labels a delivery with its FIRST line only — an in-origin wake stores a whole prompt", async () => {
    // The second half of the same live failure: `turn.message` is a short
    // header for a settle-chain delivery, but watch-fire-service's
    // `fireBucket` stores the ENTIRE consolidated wake prompt there. Relaying
    // it verbatim replayed a full instruction block as "context".
    //
    // MUTATION-PROOF: return `stripControl(delivery.message)` instead of
    // `bridgeLabel(...)` and the task lines come back.
    const { agentId, originId } = await fireAndGetRun("labelbridge");

    const conversation = await db.conversation.update({
      where: { id: originId },
      data: { lastSeq: { increment: 1 } },
      select: { lastSeq: true },
    });
    const wake = await db.turn.create({
      data: {
        conversationId: originId,
        message: [
          "[Platform wake: 2 background task(s) you were watching finished]",
          "",
          "Run tail -5 /tmp/ci.log and report the result.",
          "Then clean up: rm -rf /tmp/scratch",
          "",
          "[Recent output:]",
          "RUNNING CI",
        ].join("\n"),
        status: "done",
        source: "watch",
        userId: null,
        startedAt: new Date(),
        finishedAt: new Date(),
      },
      select: { id: true },
    });
    await db.turnEvent.create({
      data: {
        conversationId: originId,
        turnId: wake.id,
        seq: conversation.lastSeq,
        type: "text",
        payload: { type: "text", text: "Both tasks finished clean." },
      },
    });

    const asked = await turnService.createTurn(WORKSPACE, originId, "and?", {
      source: "web",
      userId: USER,
    });
    const context =
      (await turnContext.buildTurnContext(
        agentId,
        originId,
        asked.id,
        asked.message,
      )) ?? "";

    // The report itself rides, under a one-line label.
    expect(context).toContain("Both tasks finished clean.");
    expect(context).toContain("[Platform wake: 2 background task(s)");
    // The instruction body does NOT.
    expect(context).not.toContain("rm -rf");
    expect(context).not.toContain("RUNNING CI");
    expect(context).not.toContain("Recent output");
  });
});

describe.skipIf(!PROOF_URL)("the platform-tool fence", () => {
  it("derives the agent from the two authenticated facts and refuses a foreign runner's relay", async () => {
    const agentId = await seedAgent("fence");
    const sandboxId = await seedSandbox("fence", agentId, "running");

    // Runner B relaying A's sandbox: the two-fact fence must refuse,
    // hint-free. MUTATION-PROOF: drop `runnerId` from resolveIdentity's
    // where and this fails.
    const foreign = await platformTools.executePlatformTool(RUNNER_B, {
      sandboxId,
      tool: "list_tasks",
      args: {},
    });
    expect(foreign.ok).toBe(false);
    expect(foreign.error).toBe("This tool is not available.");

    const honest = await platformTools.executePlatformTool(RUNNER_A, {
      sandboxId,
      tool: "list_tasks",
      args: {},
    });
    expect(honest.ok).toBe(true);
  });

  it("schedule_task anchors origin to the VERIFIED calling turn and drops a forged context", async () => {
    const agentId = await seedAgent("anchor");
    const sandboxId = await seedSandbox("anchor", agentId, "running");
    const direct = await conversationService.ensureDirectConversation(
      WORKSPACE,
      agentId,
      USER,
    );
    const callingTurn = await turnService.createTurn(
      WORKSPACE,
      direct.id,
      "schedule the thing",
      { source: "web", userId: USER },
    );

    const created = await platformTools.executePlatformTool(RUNNER_A, {
      sandboxId,
      tool: "schedule_task",
      args: {
        name: `${P}anchored`,
        prompt: "do it",
        schedule: "0 9 * * *",
        timezone: "UTC",
      },
      conversationId: direct.id,
      turnId: callingTurn.id,
    });
    expect(created.ok).toBe(true);
    const anchored = await db.agentCron.findFirstOrThrow({
      where: { name: `${P}anchored` },
      select: { originConversationId: true, createdByUserId: true },
    });
    expect(anchored.originConversationId).toBe(direct.id);
    expect(anchored.createdByUserId).toBe(USER);

    // A forged context naming ANOTHER agent's conversation: verified against
    // the fenced agent, so it drops to null — never anchors elsewhere.
    const otherAgent = await seedAgent("anchor-other");
    const otherConversation =
      await conversationService.ensureDirectConversation(
        WORKSPACE,
        otherAgent,
        USER,
      );
    const forged = await platformTools.executePlatformTool(RUNNER_A, {
      sandboxId,
      tool: "schedule_task",
      args: {
        name: `${P}forged`,
        prompt: "do it",
        schedule: "0 9 * * *",
        timezone: "UTC",
      },
      conversationId: otherConversation.id,
    });
    expect(forged.ok).toBe(true);
    const dropped = await db.agentCron.findFirstOrThrow({
      where: { name: `${P}forged` },
      select: { originConversationId: true, createdByUserId: true },
    });
    expect(dropped.originConversationId).toBeNull();
    expect(dropped.createdByUserId).toBeNull();
  });

  it("cancel_task and a cross-tenant cron id read as not found", async () => {
    const agentId = await seedAgent("cancel");
    const sandboxId = await seedSandbox("cancel", agentId, "running");
    const foreignAgent = await seedAgent("cancel-foreign", FOREIGN_WORKSPACE);
    const foreignCron = await seedDueCron(foreignAgent, "cancel-foreign", {
      nextFireAt: new Date(Date.now() + 3_600_000),
    });

    const answer = await platformTools.executePlatformTool(RUNNER_A, {
      sandboxId,
      tool: "cancel_task",
      args: { cronId: foreignCron },
    });
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain("not found");

    const survives = await db.agentCron.findUnique({
      where: { id: foreignCron },
      select: { id: true },
    });
    expect(survives).not.toBeNull();
  });
});
