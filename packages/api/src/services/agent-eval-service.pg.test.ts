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
 * Agent EVALS on REAL PostgreSQL. Laws:
 *  - run admission is atomic across API instances (the agent row lock);
 *  - a run that stopped making progress is ended by the next run request,
 *    but never while an eval turn of the agent is still active;
 *  - questions are capped, archived questions are history (never edited),
 *    and run snapshots survive archival;
 *  - another workspace or agent reads NOT_FOUND (negative controls).
 */

// Keep the real DB admission path, but never dispatch a live sandbox turn.
const runner = vi.hoisted(() => ({ createConversation: vi.fn() }));
vi.mock("./conversation-service", () => ({
  createConversation: runner.createConversation,
}));

const url = proofDatabaseUrl();
const prefix = `eval-proof-${randomUUID()}`;
const orgId = `${prefix}-org`;
const workspaceId = `${prefix}-workspace`;
const otherWorkspaceId = `${prefix}-other-workspace`;
const agentId = `${prefix}-agent`;
const otherAgentId = `${prefix}-other-agent`;
const byoAgentId = `${prefix}-byo`;
const userId = `${prefix}-user`;
const input = {
  question: "How many customers?",
  expected: "42",
  kind: "numeric" as const,
  expectedApps: ["example-app"],
};
let db: typeof import("@onecli/db").db;
let service: typeof import("./agent-eval-service");

const result = (questionId: string) => ({
  questionId,
  question: input.question,
  expected: input.expected,
  kind: input.kind,
  expectedApps: input.expectedApps,
  outcome: "passed" as const,
  answer: "42",
  missingApps: [],
  turnId: null,
  conversationId: null,
  error: null,
});

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

/** Plant an active run whose last checkpoint was `idleMs` ago. */
const plantActiveRun = async (status: string, idleMs: number) => {
  const run = await db.agentEvalRun.create({
    data: { agentId, configVersion: "proof", status, total: 1 },
  });
  await db.$executeRaw`
    UPDATE agent_eval_runs SET updated_at = ${new Date(Date.now() - idleMs)}
    WHERE id = ${run.id}
  `;
  return run;
};

beforeAll(async () => {
  if (!url) return;
  process.env.DATABASE_URL = url;
  ({ db } = await import("@onecli/db"));
  service = await import("./agent-eval-service");
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
  await db.workspace.createMany({
    data: [workspaceId, otherWorkspaceId].map((id) => ({
      id,
      organizationId: orgId,
    })),
  });
  await db.agent.createMany({
    data: [agentId, otherAgentId, byoAgentId].map((id) => ({
      id,
      workspaceId,
      name: id,
      identifier: id,
      accessToken: id,
      kind: id === byoAgentId ? "byo" : "hosted",
    })),
  });
});

beforeEach(async () => {
  if (!url) return;
  runner.createConversation.mockReset();
  await db.conversation.deleteMany({ where: { agentId } });
  await db.agentEvalRun.deleteMany({
    where: { agentId: { in: [agentId, otherAgentId] } },
  });
  await db.agentEvalQuestion.deleteMany({
    where: { agentId: { in: [agentId, otherAgentId] } },
  });
});

afterAll(async () => {
  if (!url || !db) return;
  await db.agent.deleteMany({ where: { workspaceId } });
  await db.workspace.deleteMany({ where: { organizationId: orgId } });
  await db.organization.delete({ where: { id: orgId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

describe.skipIf(!url)("agent evals on PostgreSQL", () => {
  it("atomically admits exactly one concurrent run across independent service instances", async () => {
    await service.saveQuestion(workspaceId, agentId, null, input);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runner.createConversation.mockImplementation(async () => {
      await gate;
      throw new Error("proof runner stopped");
    });
    // A second module instance proves the database lock, not a process-local
    // guard, admits exactly one run.
    vi.resetModules();
    const otherService = await import("./agent-eval-service");
    try {
      const attempts = await Promise.allSettled([
        service.startRun(workspaceId, orgId, userId, agentId),
        otherService.startRun(workspaceId, orgId, userId, agentId),
      ]);
      expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(attempts.find((r) => r.status === "rejected")).toMatchObject({
        reason: { code: "CONFLICT" },
      });
      expect(await db.agentEvalRun.count({ where: { agentId } })).toBe(1);
    } finally {
      release();
      await vi.waitFor(async () => {
        expect(
          await db.agentEvalRun.count({
            where: { agentId, status: { in: ["queued", "running"] } },
          }),
        ).toBe(0);
      });
    }
  });

  it.each(["queued", "running"])(
    "keeps a recently active %s run and refuses a second one",
    async (status) => {
      await service.saveQuestion(workspaceId, agentId, null, input);
      await plantActiveRun(status, service.STALE_RUN_MS - 60_000);
      await expect(
        service.startRun(workspaceId, orgId, userId, agentId),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await db.agentEvalRun.count({ where: { agentId } })).toBe(1);
      expect(runner.createConversation).not.toHaveBeenCalled();
    },
  );

  it("ends a run that stopped making progress, then admits the new one", async () => {
    await service.saveQuestion(workspaceId, agentId, null, input);
    runner.createConversation.mockRejectedValue(new Error("proof stop"));
    const stale = await plantActiveRun(
      "running",
      service.STALE_RUN_MS + 60_000,
    );
    const run = await service.startRun(workspaceId, orgId, userId, agentId);
    expect(run.id).not.toBe(stale.id);
    expect(
      await db.agentEvalRun.findUniqueOrThrow({ where: { id: stale.id } }),
    ).toMatchObject({ status: "failed", error: expect.any(String) });
    await vi.waitFor(async () => {
      expect(
        (await db.agentEvalRun.findUniqueOrThrow({ where: { id: run.id } }))
          .status,
      ).not.toMatch(/queued|running/);
    });
  });

  it("never ends an idle run while an eval turn of the agent is still active", async () => {
    await service.saveQuestion(workspaceId, agentId, null, input);
    await plantActiveRun("running", 3 * service.STALE_RUN_MS);
    const conversation = await db.conversation.create({
      data: { agentId, source: "eval" },
    });
    await db.turn.create({
      data: {
        conversationId: conversation.id,
        message: "still asking",
        status: "running",
        source: "eval",
        userId,
      },
    });
    await expect(
      service.startRun(workspaceId, orgId, userId, agentId),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      await db.agentEvalRun.count({ where: { agentId, status: "running" } }),
    ).toBe(1);
  });

  it("refuses an ambiguous number check before writing", async () => {
    await expect(
      service.saveQuestion(workspaceId, agentId, null, {
        ...input,
        expected: "Q1 2026 had 42",
      }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    expect(await service.listQuestions(workspaceId, agentId)).toEqual([]);
  });

  it("creates, edits and archives a question, and never edits an archived one", async () => {
    const created = await service.saveQuestion(
      workspaceId,
      agentId,
      null,
      input,
    );
    expect(await service.listQuestions(workspaceId, agentId)).toEqual([
      created,
    ]);
    const updated = await service.saveQuestion(
      workspaceId,
      agentId,
      created.id,
      { ...input, expected: "43" },
    );
    expect(updated).toEqual({ ...created, expected: "43" });
    await service.archiveQuestion(workspaceId, agentId, created.id);
    expect(await service.listQuestions(workspaceId, agentId)).toEqual([]);
    await expect(
      service.saveQuestion(workspaceId, agentId, created.id, input),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      service.archiveQuestion(workspaceId, agentId, created.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects cross-workspace and cross-agent reads and writes", async () => {
    const created = await service.saveQuestion(
      workspaceId,
      agentId,
      null,
      input,
    );
    for (const [workspace, agent] of [
      [otherWorkspaceId, agentId],
      [workspaceId, otherAgentId],
    ] as const) {
      await expect(
        service.saveQuestion(workspace, agent, created.id, input),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        service.archiveQuestion(workspace, agent, created.id),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect(
      service.listQuestions(otherWorkspaceId, agentId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await service.listQuestions(workspaceId, otherAgentId)).toEqual([]);
    expect(await service.listQuestions(workspaceId, agentId)).toEqual([
      created,
    ]);
  });

  it("rejects unknown question IDs and agents that are not hosted", async () => {
    await expect(
      service.saveQuestion(workspaceId, agentId, randomUUID(), input),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      service.archiveQuestion(workspaceId, agentId, randomUUID()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      service.saveQuestion(workspaceId, byoAgentId, null, input),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    await expect(
      service.listQuestions(workspaceId, byoAgentId),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("serializes concurrent creates at the question cap", async () => {
    await db.agentEvalQuestion.createMany({
      data: Array.from({ length: 49 }, () => ({ ...input, agentId })),
    });
    const attempts = await Promise.allSettled([
      service.saveQuestion(workspaceId, agentId, null, input),
      service.saveQuestion(workspaceId, agentId, null, input),
    ]);
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(attempts.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "UNPROCESSABLE" },
    });
    expect(await service.listQuestions(workspaceId, agentId)).toHaveLength(50);
  });

  it("scopes run history, keeps snapshots after archival and compares with the previous completed run", async () => {
    const question = await service.saveQuestion(
      workspaceId,
      agentId,
      null,
      input,
    );
    const earlier = await db.agentEvalRun.create({
      data: {
        agentId,
        configVersion: "before",
        status: "done",
        total: 1,
        results: [result(question.id)],
        createdAt: minutesAgo(10),
      },
    });
    const later = await db.agentEvalRun.create({
      data: {
        agentId,
        configVersion: "after",
        status: "done",
        total: 1,
        results: [
          { ...result(question.id), outcome: "mismatch", answer: "41" },
        ],
      },
    });
    await service.archiveQuestion(workspaceId, agentId, question.id);

    const detail = await service.getRun(workspaceId, agentId, later.id);
    expect(detail.previous).toEqual({
      id: earlier.id,
      configVersion: "before",
    });
    expect(detail.results).toEqual([
      expect.objectContaining({
        questionId: question.id,
        outcome: "mismatch",
        change: "regressed",
      }),
    ]);
    expect(detail.counts).toMatchObject({ passed: 0, mismatch: 1 });
    const runs = await service.listRuns(workspaceId, agentId);
    expect(runs.map((r) => r.id)).toEqual([later.id, earlier.id]);
    await expect(
      service.getRun(otherWorkspaceId, agentId, later.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      service.getRun(workspaceId, otherAgentId, later.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await service.listRuns(workspaceId, otherAgentId)).toEqual([]);
  });

  it("keeps a run's history when the user who started it is deleted", async () => {
    const departing = await db.user.create({
      data: {
        id: `${prefix}-departing`,
        email: `${prefix}-d@example.com`,
        externalAuthId: `${prefix}-departing`,
      },
    });
    const run = await db.agentEvalRun.create({
      data: {
        agentId,
        configVersion: "proof",
        status: "done",
        total: 0,
        createdByUserId: departing.id,
      },
    });
    await db.user.delete({ where: { id: departing.id } });
    expect(
      await db.agentEvalRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).toMatchObject({ createdByUserId: null });
  });
});
