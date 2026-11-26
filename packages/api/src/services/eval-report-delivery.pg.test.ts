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
import type { EvalResult } from "../validations/evals";

/**
 * Sending a SCHEDULED eval run's results, on REAL PostgreSQL. Laws:
 *  - the schedule saves where results go; absent keeps it (the pause
 *    switch), null clears it; a channel the bot is not in is refused;
 *  - `chat` lands a finished turn in the creator's direct thread;
 *  - `channel` posts once through the provider, with no turn anywhere;
 *  - `when` quiets a run with nothing to report, but a failed run is
 *    always sent; a manual run is never sent;
 *  - a channel set to Never is not posted to, and a provider error never
 *    escapes (the run is already recorded).
 *
 * Only the provider is faked (a recording `sendMessage`/`listChannels`):
 * the DB, the crypto, the direct-thread door and the born-done turn are
 * the production ones.
 */

const provider = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  listChannels: vi.fn(),
}));
vi.mock("./channels/registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("./channels/registry")>();
  return {
    ...real,
    channelProvider: () => ({
      ...real.channelProvider("slack"),
      sendMessage: provider.sendMessage,
      listChannels: provider.listChannels,
    }),
  };
});

const url = proofDatabaseUrl();
const prefix = `evreport-proof-${randomUUID()}`;
const orgId = `${prefix}-org`;
const workspaceId = `${prefix}-workspace`;
const agentId = `${prefix}-agent`;
const userId = `${prefix}-user`;
const QA = { ref: "CQA", name: "qa", member: true, private: false };
const daily = { schedule: "0 9 * * *", timezone: "UTC", enabled: true };

let db: typeof import("@onecli/db").db;
let schedules: typeof import("./eval-schedule-service");
let delivery: typeof import("./eval-report-delivery");

const result = (
  questionId: string,
  outcome: EvalResult["outcome"],
): EvalResult => ({
  questionId,
  question: `Question ${questionId}?`,
  expected: "42",
  kind: "numeric",
  expectedApps: [],
  outcome,
  answer: "42",
  missingApps: null,
  turnId: null,
  conversationId: null,
  error: null,
  judgement: null,
  judgeError: null,
});

let clock = Date.now() - 60 * 60_000;
/** A settled run, each one later than the last. */
const seedRun = async (
  results: EvalResult[],
  options: {
    status?: "done" | "failed";
    trigger?: "manual" | "scheduled";
    error?: string;
  } = {},
) => {
  clock += 60_000;
  const run = await db.agentEvalRun.create({
    data: {
      agentId,
      createdByUserId: userId,
      status: options.status ?? "done",
      trigger: options.trigger ?? "scheduled",
      configVersion: "v1",
      total: results.length,
      results,
      error: options.error ?? null,
      createdAt: new Date(clock),
      finishedAt: new Date(clock),
    },
    select: { id: true },
  });
  return run.id;
};

const chatTurns = () =>
  db.turn.findMany({
    where: { conversation: { agentId, direct: true, userId } },
    select: { message: true, source: true, status: true, id: true },
  });

const chatText = async () => {
  const turns = await chatTurns();
  const events = await db.turnEvent.findMany({
    where: { turnId: { in: turns.map((t) => t.id) }, type: "text" },
    select: { payload: true },
  });
  return events.map((e) => String((e.payload as { text: string }).text));
};

beforeAll(async () => {
  if (!url) return;
  process.env.DATABASE_URL = url;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");
  process.env.APP_URL = "https://app.example.test";
  ({ db } = await import("@onecli/db"));
  schedules = await import("./eval-schedule-service");
  delivery = await import("./eval-report-delivery");
  const { getCrypto } = await import("../providers");

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
  await db.workspace.create({
    data: { id: workspaceId, organizationId: orgId },
  });
  await db.agent.create({
    data: {
      id: agentId,
      workspaceId,
      name: "Dana",
      identifier: agentId,
      accessToken: agentId,
      kind: "hosted",
    },
  });
  const integration = await db.channelIntegration.create({
    data: {
      organizationId: orgId,
      provider: "slack",
      externalId: `T-${prefix}`,
      name: "Acme",
      createdByUserId: userId,
    },
    select: { id: true },
  });
  await db.agentChannel.create({
    data: {
      agentId,
      integrationId: integration.id,
      provider: "slack",
      externalId: `A-${prefix}`,
      identityRef: "UBOT",
      transport: "socket",
      status: "active",
      credentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-proof" }),
      ),
      createdByUserId: userId,
    },
  });
});

beforeEach(async () => {
  if (!url) return;
  provider.sendMessage.mockReset();
  provider.sendMessage.mockResolvedValue({ externalThreadId: "CQA:1.0" });
  provider.listChannels.mockReset();
  // Asked for its own channels, the bot is in #qa only; COUT is a channel
  // it never joined.
  provider.listChannels.mockImplementation(
    async ({ ownOnly }: { ownOnly?: boolean }) =>
      ownOnly
        ? [QA]
        : [QA, { ref: "COUT", name: "outside", member: false, private: false }],
  );
  await db.agentEvalSchedule.deleteMany({ where: { agentId } });
  await db.agentEvalRun.deleteMany({ where: { agentId } });
  await db.agentReachGrant.deleteMany({ where: { agentId } });
  await db.conversation.deleteMany({ where: { agentId } });
});

afterAll(async () => {
  if (!url || !db) return;
  await db.agent.deleteMany({ where: { workspaceId } });
  await db.channelIntegration.deleteMany({ where: { organizationId: orgId } });
  await db.workspace.deleteMany({ where: { organizationId: orgId } });
  await db.organization.delete({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: userId } });
  await db.$disconnect();
});

describe.skipIf(!url)("scheduled eval results on PostgreSQL", () => {
  it("saves where results go; absent keeps it, null clears it", async () => {
    const saved = await schedules.saveEvalSchedule(
      workspaceId,
      agentId,
      userId,
      {
        ...daily,
        report: { to: "channel", channelRef: "CQA", when: "changes" },
      },
    );
    expect(saved.report).toEqual({
      to: "channel",
      channelRef: "CQA",
      channelLabel: "#qa",
      when: "changes",
    });

    // The pause switch saves without `report`: the setting stays.
    const paused = await schedules.saveEvalSchedule(
      workspaceId,
      agentId,
      userId,
      { ...daily, enabled: false },
    );
    expect(paused.report).toEqual(saved.report);

    const cleared = await schedules.saveEvalSchedule(
      workspaceId,
      agentId,
      userId,
      { ...daily, report: null },
    );
    expect(cleared.report).toBeNull();
  });

  it("refuses a channel the agent is not in", async () => {
    await expect(
      schedules.saveEvalSchedule(workspaceId, agentId, userId, {
        ...daily,
        report: { to: "channel", channelRef: "COUT", when: "always" },
      }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    expect(
      await schedules.listEvalReportChannels(workspaceId, agentId),
    ).toEqual([{ ref: "CQA", name: "#qa", private: false }]);
  });

  it("chat: lands a finished turn in the creator's thread, with a link to the run", async () => {
    await schedules.saveEvalSchedule(workspaceId, agentId, userId, {
      ...daily,
      report: { to: "chat", when: "always" },
    });
    await seedRun([result("a", "passed"), result("b", "passed")]);
    const runId = await seedRun([
      result("a", "passed"),
      result("b", "mismatch"),
    ]);

    await delivery.deliverEvalRunReport(workspaceId, agentId, runId);

    const turns = await chatTurns();
    expect(turns).toEqual([
      expect.objectContaining({
        message: delivery.EVAL_REPORT_HEADER,
        source: "cron",
        status: "done",
      }),
    ]);
    const [text] = await chatText();
    expect(text).toContain(
      "**Dana's scheduled tests: 1 of 2 passed** (1 broke since last run)",
    );
    // The run's own details: same setup as the run it is compared with.
    expect(text).toContain("_no changes to the agent since last run_");
    expect(text).toContain(
      '**2. Question b?**\n> Broke since last run. Expected 42, the agent said "42".',
    );
    expect(text).toContain(
      `[Open the full results](https://app.example.test/w/${workspaceId}/agents/${agentId}/evals?run=${runId})`,
    );
    expect(provider.sendMessage).not.toHaveBeenCalled();
  });

  it("channel: posts once through the provider, and no turn is created", async () => {
    await schedules.saveEvalSchedule(workspaceId, agentId, userId, {
      ...daily,
      report: { to: "channel", channelRef: "CQA", when: "always" },
    });
    const runId = await seedRun([result("a", "passed")]);

    await delivery.deliverEvalRunReport(workspaceId, agentId, runId);

    expect(provider.sendMessage).toHaveBeenCalledTimes(1);
    expect(provider.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { kind: "channel", ref: "CQA" },
        text: expect.stringContaining(
          "**Dana's scheduled tests: all 1 passed**",
        ),
      }),
    );
    expect(await chatTurns()).toEqual([]);
  });

  it("`changes` stays quiet when nothing changed, but a failed run is always sent", async () => {
    await schedules.saveEvalSchedule(workspaceId, agentId, userId, {
      ...daily,
      report: { to: "chat", when: "changes" },
    });
    await seedRun([result("a", "mismatch")]);
    const same = await seedRun([result("a", "mismatch")]);
    await delivery.deliverEvalRunReport(workspaceId, agentId, same);
    expect(await chatTurns()).toEqual([]);

    const failed = await seedRun([], {
      status: "failed",
      error: "The agent's model key was removed",
    });
    await delivery.deliverEvalRunReport(workspaceId, agentId, failed);
    const [text] = await chatText();
    expect(text).toContain("**Dana's scheduled tests didn't finish**");
    expect(text).toContain("> The agent's model key was removed.");
  });

  it("never sends a manual run", async () => {
    await schedules.saveEvalSchedule(workspaceId, agentId, userId, {
      ...daily,
      report: { to: "chat", when: "always" },
    });
    const runId = await seedRun([result("a", "passed")], { trigger: "manual" });
    await delivery.deliverEvalRunReport(workspaceId, agentId, runId);
    expect(await chatTurns()).toEqual([]);
  });

  it("does not post to a channel set to Never, and a provider error never escapes", async () => {
    await schedules.saveEvalSchedule(workspaceId, agentId, userId, {
      ...daily,
      report: { to: "channel", channelRef: "CQA", when: "always" },
    });
    const runId = await seedRun([result("a", "passed")]);

    provider.sendMessage.mockRejectedValueOnce(new Error("channel_not_found"));
    await expect(
      delivery.deliverEvalRunReport(workspaceId, agentId, runId),
    ).resolves.toBeUndefined();

    const presence = await db.agentChannel.findFirstOrThrow({
      where: { agentId },
      select: { integrationId: true },
    });
    await db.agentReachGrant.create({
      data: {
        agentId,
        integrationId: presence.integrationId,
        provider: "slack",
        subjectKind: "space",
        externalRef: "CQA",
        state: "blocked",
      },
    });
    provider.sendMessage.mockClear();
    await delivery.deliverEvalRunReport(workspaceId, agentId, runId);
    expect(provider.sendMessage).not.toHaveBeenCalled();
  });
});
