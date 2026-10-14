import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { proofDatabaseUrl } from "../testing/pg-proof";

/**
 * Agent EVAL SCHEDULES on REAL PostgreSQL. Laws:
 *  - a due schedule is claimed exactly once under concurrent pollers;
 *  - disabled and not-yet-due schedules are never claimed;
 *  - a save mid-claim wins the lease CAS, and that fire is skipped;
 *  - a fire is a real `scheduled` eval run on the creator's authority;
 *  - no questions / a run already going are recorded skips, not failures;
 *  - a schedule whose creator is gone disables itself, never runs;
 *  - a creator who lost workspace access disables it too (RBAC);
 *  - another workspace reads NOT_FOUND (negative control).
 *
 * The creator's authority goes through the production check in BOTH CI
 * lanes: the suite boots the way the server does (`ensureEditionDefaults`)
 * and forces `CAPS.rbac` on, so the licensed admin-or-binding resolution
 * answers. The creator is a plain member granted the workspace through a
 * WorkspaceAccess binding, the real shape of "may this person run tests
 * here". Without that, the onprem lane would pass by the flat team's
 * always-yes, and the cloud lane would fail on an unwired checker.
 */

// Keep the real DB admission path, but never dispatch a live sandbox turn.
const runner = vi.hoisted(() => ({ createConversation: vi.fn() }));
vi.mock("./conversation-service", () => ({
  createConversation: runner.createConversation,
}));

const url = proofDatabaseUrl();
const prefix = `evsched-proof-${randomUUID()}`;
const orgId = `${prefix}-org`;
const workspaceId = `${prefix}-workspace`;
const otherWorkspaceId = `${prefix}-other-workspace`;
const agentId = `${prefix}-agent`;
const userId = `${prefix}-user`;
const daily = { schedule: "0 9 * * *", timezone: "UTC", enabled: true };

let db: typeof import("@onecli/db").db;
let schedules: typeof import("./eval-schedule-service");
let dueWork: typeof import("./due-work");
let fire: typeof import("./eval-schedule-fire-service");

/** Make the agent's schedule due now. */
const makeDue = () =>
  db.agentEvalSchedule.update({
    where: { agentId },
    data: { nextFireAt: new Date(Date.now() - 1_000) },
  });

const addQuestion = () =>
  db.agentEvalQuestion.create({
    data: { agentId, question: "How many?", expected: "42", kind: "numeric" },
  });

beforeAll(async () => {
  if (!url) return;
  process.env.DATABASE_URL = url;
  ({ db } = await import("@onecli/db"));
  // Boot like the server, then enforce roles for real (see the header).
  const { ensureEditionDefaults } = await import("../edition-defaults");
  ensureEditionDefaults();
  const { eeWorkspaceAccessChecker } =
    await import("../ee/services/authorization-service");
  const { initWorkspaceAccessChecker } =
    await import("../providers/access-checker");
  initWorkspaceAccessChecker(eeWorkspaceAccessChecker);
  const env = await import("../lib/env");
  Object.defineProperty(env.CAPS, "rbac", { value: true, configurable: true });
  schedules = await import("./eval-schedule-service");
  dueWork = await import("./due-work");
  fire = await import("./eval-schedule-fire-service");
  await db.organization.create({
    data: { id: orgId, name: prefix, slug: prefix },
  });
  await db.user.create({
    data: {
      id: userId,
      email: `${prefix}@example.com`,
      externalAuthId: userId,
    },
  });
  await db.organizationMember.create({
    data: {
      organizationId: orgId,
      userId,
      userEmail: `${prefix}@example.com`,
      role: "member",
    },
  });
  await db.workspace.createMany({
    data: [workspaceId, otherWorkspaceId].map((id) => ({
      id,
      organizationId: orgId,
    })),
  });
  // The creator's access to the agent's workspace: a member's only grant.
  await db.workspaceAccess.create({ data: { workspaceId, userId } });
  await db.agent.create({
    data: {
      id: agentId,
      workspaceId,
      name: agentId,
      identifier: agentId,
      accessToken: agentId,
      kind: "hosted",
    },
  });
});

beforeEach(async () => {
  if (!url) return;
  runner.createConversation.mockReset();
  // The worker's first step fails, so each admitted run settles as failed
  // without a sandbox; the admission and the run row are what is proven.
  runner.createConversation.mockRejectedValue(new Error("proof: no sandbox"));
  await db.agentEvalSchedule.deleteMany({ where: { agentId } });
  await db.agentEvalRun.deleteMany({ where: { agentId } });
  await db.agentEvalQuestion.deleteMany({ where: { agentId } });
});

afterAll(async () => {
  if (!url || !db) return;
  await db.agent.deleteMany({ where: { workspaceId } });
  await db.workspace.deleteMany({ where: { organizationId: orgId } });
  await db.organizationMember.deleteMany({ where: { organizationId: orgId } });
  await db.organization.delete({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: userId } });
  await db.$disconnect();
});

describe.skipIf(!url)("eval schedules on PostgreSQL", () => {
  it("saves one schedule per agent, replaces it on save, and fences other workspaces", async () => {
    const first = await schedules.saveEvalSchedule(
      workspaceId,
      agentId,
      userId,
      daily,
    );
    expect(first.nextFireAt.getTime()).toBeGreaterThan(Date.now());
    await schedules.saveEvalSchedule(workspaceId, agentId, userId, {
      ...daily,
      schedule: "30 7 * * 1-5",
    });
    expect(await db.agentEvalSchedule.count({ where: { agentId } })).toBe(1);
    expect(
      (await schedules.getEvalSchedule(workspaceId, agentId))?.schedule,
    ).toBe("30 7 * * 1-5");

    // Negative controls: the agent read through another workspace.
    await expect(
      schedules.getEvalSchedule(otherWorkspaceId, agentId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      schedules.saveEvalSchedule(otherWorkspaceId, agentId, userId, daily),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      schedules.deleteEvalSchedule(otherWorkspaceId, agentId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db.agentEvalSchedule.count({ where: { agentId } })).toBe(1);
  });

  it("refuses an expression or timezone croner cannot use", async () => {
    await expect(
      schedules.saveEvalSchedule(workspaceId, agentId, userId, {
        ...daily,
        schedule: "every morning",
      }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    await expect(
      schedules.saveEvalSchedule(workspaceId, agentId, userId, {
        ...daily,
        timezone: "Mars/Olympus",
      }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("refuses schedules that run more than once an hour; hourly is allowed", async () => {
    for (const schedule of ["* * * * *", "*/30 * * * *", "0,30 9 * * *"])
      await expect(
        schedules.saveEvalSchedule(workspaceId, agentId, userId, {
          ...daily,
          schedule,
        }),
      ).rejects.toMatchObject({
        code: "UNPROCESSABLE",
        message: "Scheduled tests can run at most once an hour",
      });
    expect(await db.agentEvalSchedule.count({ where: { agentId } })).toBe(0);
    await expect(
      schedules.saveEvalSchedule(workspaceId, agentId, userId, {
        ...daily,
        schedule: "0 * * * *",
      }),
    ).resolves.toMatchObject({ schedule: "0 * * * *" });
  });

  it("claims a due schedule exactly once under two concurrent pollers", async () => {
    await schedules.saveEvalSchedule(workspaceId, agentId, userId, daily);
    await makeDue();
    const [a, b] = await Promise.all([
      dueWork.claimDueEvalSchedules(),
      dueWork.claimDueEvalSchedules(),
    ]);
    const mine = [...a.schedules, ...b.schedules].filter(
      (s) => s.agentId === agentId,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      workspaceId,
      organizationId: orgId,
      createdByUserId: userId,
    });
  });

  it("never claims a paused or not-yet-due schedule", async () => {
    await schedules.saveEvalSchedule(workspaceId, agentId, userId, daily);
    const notDue = await dueWork.claimDueEvalSchedules();
    expect(notDue.schedules.some((s) => s.agentId === agentId)).toBe(false);

    await schedules.saveEvalSchedule(workspaceId, agentId, userId, {
      ...daily,
      enabled: false,
    });
    await makeDue();
    const paused = await dueWork.claimDueEvalSchedules();
    expect(paused.schedules.some((s) => s.agentId === agentId)).toBe(false);
  });

  it("a save mid-claim wins the lease, and the claimed fire is skipped", async () => {
    await schedules.saveEvalSchedule(workspaceId, agentId, userId, daily);
    await makeDue();
    const { lease } = await dueWork.claimDueEvalSchedules();
    await schedules.saveEvalSchedule(workspaceId, agentId, userId, daily);
    const row = await db.agentEvalSchedule.findUniqueOrThrow({
      where: { agentId },
    });
    expect(
      await dueWork.advanceClaimedEvalSchedule(row.id, lease, new Date()),
    ).toBe(false);
  });

  it("a fire admits a real scheduled run on the creator's authority, and advances", async () => {
    await addQuestion();
    await schedules.saveEvalSchedule(workspaceId, agentId, userId, daily);
    await makeDue();
    await fire.fireDueEvalSchedules();

    const run = await db.agentEvalRun.findFirstOrThrow({ where: { agentId } });
    expect(run).toMatchObject({
      trigger: "scheduled",
      createdByUserId: userId,
      total: 1,
    });
    const row = await db.agentEvalSchedule.findUniqueOrThrow({
      where: { agentId },
    });
    expect(row).toMatchObject({ lastOutcome: "started" });
    expect(row.lastFiredAt).not.toBeNull();
    expect(row.nextFireAt.getTime()).toBeGreaterThan(Date.now());
    // The run shows in the history the dashboard reads, marked scheduled.
    const [listed] = await (
      await import("./agent-eval-service")
    ).listRuns(workspaceId, agentId);
    expect(listed).toMatchObject({ id: run.id, trigger: "scheduled" });
  });

  it("records a skip, not a failure, with no questions or a run already going", async () => {
    await schedules.saveEvalSchedule(workspaceId, agentId, userId, daily);
    await makeDue();
    await fire.fireDueEvalSchedules();
    expect(
      await db.agentEvalSchedule.findUniqueOrThrow({ where: { agentId } }),
    ).toMatchObject({ lastOutcome: "skipped_no_questions", enabled: true });
    expect(await db.agentEvalRun.count({ where: { agentId } })).toBe(0);

    await addQuestion();
    await db.agentEvalRun.create({
      data: { agentId, configVersion: "proof", status: "running", total: 1 },
    });
    await makeDue();
    await fire.fireDueEvalSchedules();
    expect(
      await db.agentEvalSchedule.findUniqueOrThrow({ where: { agentId } }),
    ).toMatchObject({ lastOutcome: "skipped_busy", enabled: true });
    expect(await db.agentEvalRun.count({ where: { agentId } })).toBe(1);
  });

  it("disables itself, starting nothing, when its creator is gone", async () => {
    await addQuestion();
    await schedules.saveEvalSchedule(workspaceId, agentId, userId, daily);
    await db.agentEvalSchedule.update({
      where: { agentId },
      data: { createdByUserId: null },
    });
    await makeDue();
    await fire.fireDueEvalSchedules();
    expect(
      await db.agentEvalSchedule.findUniqueOrThrow({ where: { agentId } }),
    ).toMatchObject({ enabled: false, disabledReason: "authorization" });
    expect(await db.agentEvalRun.count({ where: { agentId } })).toBe(0);
  });

  it("disables itself, starting nothing, when its creator was removed or suspended", async () => {
    await addQuestion();
    const where = { organizationId_userId: { organizationId: orgId, userId } };
    for (const change of ["suspend", "remove"] as const) {
      await schedules.saveEvalSchedule(workspaceId, agentId, userId, daily);
      if (change === "suspend")
        await db.organizationMember.update({
          where,
          data: { status: "suspended" },
        });
      else await db.organizationMember.delete({ where });
      await makeDue();
      await fire.fireDueEvalSchedules();
      expect(
        await db.agentEvalSchedule.findUniqueOrThrow({ where: { agentId } }),
      ).toMatchObject({ enabled: false, disabledReason: "authorization" });
      expect(await db.agentEvalRun.count({ where: { agentId } })).toBe(0);
      // Restore the membership for the next case and later tests.
      await db.organizationMember.upsert({
        where,
        create: {
          organizationId: orgId,
          userId,
          userEmail: `${prefix}@example.com`,
          role: "member",
        },
        update: { status: "active" },
      });
    }
  });

  it("disables itself, starting nothing, when its creator lost access to the workspace", async () => {
    await addQuestion();
    await schedules.saveEvalSchedule(workspaceId, agentId, userId, daily);
    await db.workspaceAccess.deleteMany({ where: { workspaceId, userId } });
    try {
      await makeDue();
      await fire.fireDueEvalSchedules();
      expect(
        await db.agentEvalSchedule.findUniqueOrThrow({ where: { agentId } }),
      ).toMatchObject({ enabled: false, disabledReason: "authorization" });
      expect(await db.agentEvalRun.count({ where: { agentId } })).toBe(0);
    } finally {
      await db.workspaceAccess.create({ data: { workspaceId, userId } });
    }
  });

  it("a save mid-claim also wins against the authorization step: the new saver's schedule stays on", async () => {
    // The paused message tells a colleague to "save it again to resume it
    // as you". If that save lands while a fire of the OLD creator's lease
    // is in flight, the fire must not switch the fresh schedule off.
    const colleague = `${prefix}-colleague`;
    await db.user.create({
      data: {
        id: colleague,
        email: `${colleague}@example.com`,
        externalAuthId: colleague,
      },
    });
    await db.organizationMember.create({
      data: {
        organizationId: orgId,
        userId: colleague,
        userEmail: `${colleague}@example.com`,
        role: "member",
      },
    });
    try {
      await addQuestion();
      await schedules.saveEvalSchedule(workspaceId, agentId, userId, daily);
      await db.agentEvalSchedule.update({
        where: { agentId },
        data: { createdByUserId: null },
      });
      await makeDue();
      const { lease, schedules: claimed } =
        await dueWork.claimDueEvalSchedules();
      expect(claimed).toHaveLength(1);
      // The colleague saves while the claimed fire is still in flight.
      await schedules.saveEvalSchedule(workspaceId, agentId, colleague, daily);
      await fire.fireClaimedEvalSchedule(claimed[0]!, lease);

      expect(
        await db.agentEvalSchedule.findUniqueOrThrow({ where: { agentId } }),
      ).toMatchObject({
        enabled: true,
        disabledReason: null,
        createdByUserId: colleague,
      });
    } finally {
      await db.agentEvalSchedule.deleteMany({ where: { agentId } });
      await db.organizationMember.deleteMany({ where: { userId: colleague } });
      await db.user.deleteMany({ where: { id: colleague } });
    }
  });

  it("run now pulls the next fire to now; it refuses a paused schedule", async () => {
    await schedules.saveEvalSchedule(workspaceId, agentId, userId, daily);
    const now = await schedules.runEvalScheduleNow(workspaceId, agentId);
    expect(now.nextFireAt.getTime()).toBeLessThanOrEqual(Date.now());
    await schedules.saveEvalSchedule(workspaceId, agentId, userId, {
      ...daily,
      enabled: false,
    });
    await expect(
      schedules.runEvalScheduleNow(workspaceId, agentId),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });
});
