import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalResult } from "../validations/evals";
import { ServiceError } from "./errors";

const mocks = vi.hoisted(() => ({
  agent: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn() },
  skill: { findMany: vi.fn() },
  policyRuleIdentity: { findMany: vi.fn() },
  agentEvalQuestion: { findMany: vi.fn() },
  agentEvalRun: {
    findFirst: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  turn: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn() },
  queryRaw: vi.fn(),
  createConversation: vi.fn(),
  createTurn: vi.fn(),
  abortTurn: vi.fn(),
  getEvalRunEvidence: vi.fn(),
  judgeAnswer: vi.fn(),
}));
vi.mock("@onecli/db", () => ({
  db: {
    ...mocks,
    $transaction: (fn: (tx: object) => Promise<unknown>) =>
      fn({ ...mocks, $queryRaw: mocks.queryRaw }),
  },
  Prisma: {},
}));
vi.mock("./conversation-service", () => ({
  createConversation: mocks.createConversation,
}));
vi.mock("./turn-service", () => ({
  createTurn: mocks.createTurn,
  abortTurn: mocks.abortTurn,
}));
vi.mock("./agent-runs-service", () => ({
  getEvalRunEvidence: mocks.getEvalRunEvidence,
}));
vi.mock("./eval-judge", () => ({
  judgeAnswer: mocks.judgeAnswer,
}));
vi.mock("../lib/logger", () => ({
  logger: { child: () => ({ error: vi.fn(), warn: vi.fn() }) },
}));

import { NoEvalQuestionsError, listRuns, startRun } from "./agent-eval-service";

const question = {
  id: "q1",
  question: "How many?",
  expected: "42",
  kind: "numeric",
  expectedApps: ["example-app"],
};
/** The run row as the worker last wrote it. */
let saved: { status: string; results: EvalResult[]; error?: string };
let checkpoints: EvalResult[][];
let runActive: boolean;
const start = () => startRun("workspace", "org", "user", "agent");
const finish = () => vi.runAllTimersAsync();
const evidence = (patch: object = {}) => ({
  answer: "42",
  appsUsed: ["example-app"],
  appAttribution: "agent_time_window",
  ...patch,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  saved = { status: "queued", results: [] };
  checkpoints = [];
  runActive = true;
  mocks.agent.findFirst.mockResolvedValue({ kind: "hosted" });
  mocks.agent.findUniqueOrThrow.mockResolvedValue({
    instructions: "",
    model: "test",
    effort: "",
  });
  mocks.skill.findMany.mockResolvedValue([]);
  mocks.policyRuleIdentity.findMany.mockResolvedValue([]);
  mocks.queryRaw.mockResolvedValue([{ id: "agent" }]);
  mocks.agentEvalQuestion.findMany.mockResolvedValue([question]);
  mocks.agentEvalRun.findFirst.mockResolvedValue(null);
  mocks.turn.findFirst.mockResolvedValue(null);
  mocks.agentEvalRun.create.mockResolvedValue({
    id: "run1",
    status: "queued",
    configVersion: "cfg",
    total: 1,
    results: [],
    error: null,
    createdAt: new Date(),
    startedAt: null,
    finishedAt: null,
  });
  mocks.agentEvalRun.updateMany.mockImplementation(async ({ where, data }) => {
    // Only the worker's own writes (by run id) touch the planted row; the
    // admission's stale-run sweep matches no row here.
    if (where.id !== "run1" || !runActive) return { count: 0 };
    saved = { ...saved, ...structuredClone(data) };
    if (data.results) checkpoints.push(structuredClone(data.results));
    if (data.status === "done" || data.status === "failed") runActive = false;
    return { count: 1 };
  });
  mocks.createConversation.mockResolvedValue({ id: "conversation1" });
  mocks.createTurn.mockResolvedValue({ id: "turn1" });
  mocks.turn.findUniqueOrThrow.mockResolvedValue({
    status: "done",
    error: null,
  });
  mocks.abortTurn.mockResolvedValue({ aborted: true, delivered: true });
  mocks.getEvalRunEvidence.mockResolvedValue(evidence());
});
afterEach(() => {
  vi.useRealTimers();
});

describe("run admission", () => {
  it("lists a run stored in an older format as failed, instead of failing the screen", async () => {
    mocks.agentEvalRun.findMany.mockResolvedValue([
      {
        id: "old",
        status: "done",
        configVersion: "cfg",
        total: 2,
        results: [{ itemId: "gq_1", pass: false, scores: {} }],
        error: null,
        createdAt: new Date(),
        startedAt: null,
        finishedAt: null,
      },
    ]);
    const [run] = await listRuns("workspace", "agent");
    expect(run).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/older format/),
      counts: { pending: 0, passed: 0 },
    });
  });
  it("refuses a run with no questions: the same 422 a person always got, typed for the schedule", async () => {
    mocks.agentEvalQuestion.findMany.mockResolvedValue([]);
    const refusal = start();
    await expect(refusal).rejects.toBeInstanceOf(NoEvalQuestionsError);
    await expect(refusal).rejects.toMatchObject({
      code: "UNPROCESSABLE",
      message: "Add a test question first",
    });
    expect(mocks.agentEvalRun.create).not.toHaveBeenCalled();
  });

  it("refuses a second run while one is active, without asking anything", async () => {
    mocks.agentEvalRun.findFirst.mockResolvedValue({ id: "busy" });
    await expect(start()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(mocks.agentEvalRun.create).not.toHaveBeenCalled();
    expect(mocks.createTurn).not.toHaveBeenCalled();
  });

  it("ends stale runs before admitting, only when no eval turn is active", async () => {
    await start();
    expect(mocks.agentEvalRun.updateMany).toHaveBeenCalledWith({
      where: {
        agentId: "agent",
        status: { in: ["queued", "running"] },
        updatedAt: { lt: expect.any(Date) },
      },
      data: expect.objectContaining({ status: "failed" }),
    });
  });

  it("leaves an idle run alone while an eval turn of the agent is active", async () => {
    mocks.turn.findFirst.mockResolvedValue({ id: "active-turn" });
    await start();
    expect(mocks.agentEvalRun.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ updatedAt: expect.anything() }),
      }),
    );
  });

  it("needs at least one question", async () => {
    mocks.agentEvalQuestion.findMany.mockResolvedValue([]);
    await expect(start()).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });
});

describe("the worker", () => {
  it("scores a completed turn and checkpoints its identifiers first", async () => {
    await start();
    await finish();
    expect(saved.status).toBe("done");
    expect(saved.results).toEqual([
      expect.objectContaining({
        questionId: "q1",
        outcome: "passed",
        answer: "42",
        missingApps: [],
        turnId: "turn1",
        conversationId: "conversation1",
        error: null,
      }),
    ]);
    expect(checkpoints[0]?.[0]).toMatchObject({
      outcome: "pending",
      turnId: "turn1",
    });
    expect(mocks.getEvalRunEvidence).toHaveBeenCalledWith(
      "workspace",
      "org",
      "user",
      "agent",
      "turn1",
      ["example-app"],
    );
  });

  describe("a custom check", () => {
    const custom = {
      ...question,
      kind: "custom",
      expected: "Mentions 42. Pass when every fact is there.",
      expectedApps: [],
    };
    const judgement = {
      passed: true,
      summary: "All facts present.",
      criteria: [{ criterion: "Mentions 42", met: true, note: "“42”" }],
      model: "judge-model",
    };

    it("asks the judge with the question, the criteria and the answer, and keeps its verdict", async () => {
      mocks.agentEvalQuestion.findMany.mockResolvedValue([custom]);
      mocks.judgeAnswer.mockResolvedValue({ ok: true, judgement });
      await start();
      await finish();
      expect(mocks.judgeAnswer).toHaveBeenCalledWith({
        agent: { id: "agent", workspaceId: "workspace" },
        organizationId: "org",
        question: custom.question,
        criteria: custom.expected,
        answer: "42",
      });
      expect(saved.results[0]).toMatchObject({
        outcome: "passed",
        judgement,
        judgeError: null,
      });
    });

    it("is a mismatch when the judge fails it", async () => {
      mocks.agentEvalQuestion.findMany.mockResolvedValue([custom]);
      mocks.judgeAnswer.mockResolvedValue({
        ok: true,
        judgement: { ...judgement, passed: false },
      });
      await start();
      await finish();
      expect(saved.results[0]).toMatchObject({ outcome: "mismatch" });
    });

    it("is inconclusive, never a pass, when the judge could not run", async () => {
      mocks.agentEvalQuestion.findMany.mockResolvedValue([custom]);
      mocks.judgeAnswer.mockResolvedValue({
        ok: false,
        error: "The judge timed out",
      });
      await start();
      await finish();
      expect(saved.results[0]).toMatchObject({
        outcome: "inconclusive",
        judgement: null,
        judgeError: "The judge timed out",
      });
    });

    it("never judges an unfinished turn", async () => {
      mocks.agentEvalQuestion.findMany.mockResolvedValue([custom]);
      mocks.turn.findUniqueOrThrow.mockResolvedValue({
        status: "failed",
        error: null,
      });
      await start();
      await finish();
      expect(mocks.judgeAnswer).not.toHaveBeenCalled();
      expect(saved.results[0]).toMatchObject({ outcome: "error" });
    });

    it("never calls the judge for the simple checks", async () => {
      await start();
      await finish();
      expect(mocks.judgeAnswer).not.toHaveBeenCalled();
      expect(saved.results[0]).toMatchObject({
        judgement: null,
        judgeError: null,
      });
    });
  });

  it("keeps consecutive questions' evidence windows apart", async () => {
    mocks.agentEvalQuestion.findMany.mockResolvedValue([
      question,
      { ...question, id: "q2" },
    ]);
    await start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.createTurn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_499);
    expect(mocks.createTurn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.createTurn).toHaveBeenCalledTimes(2);
    await finish();
    expect(saved.results.map((r) => r.outcome)).toEqual(["passed", "passed"]);
  });

  it("is inconclusive, not a pass or a missing app, when app evidence is withheld", async () => {
    mocks.getEvalRunEvidence.mockResolvedValue(
      evidence({ appsUsed: [], appAttribution: "withheld" }),
    );
    await start();
    await finish();
    expect(saved.results[0]).toMatchObject({
      outcome: "inconclusive",
      missingApps: null,
      error: null,
    });
  });

  it.each([
    ["failed", "Failed"],
    ["aborted", "Stopped"],
  ])(
    "never passes a %s turn with a matching partial answer",
    async (status, error) => {
      mocks.turn.findUniqueOrThrow.mockResolvedValue({ status, error: null });
      await start();
      await finish();
      expect(saved.results[0]).toMatchObject({
        outcome: "error",
        answer: "42",
        error,
      });
    },
  );

  it("never passes a done turn carrying an error", async () => {
    mocks.turn.findUniqueOrThrow.mockResolvedValue({
      status: "done",
      error: "upstream failed",
    });
    await start();
    await finish();
    expect(saved.results[0]).toMatchObject({
      outcome: "error",
      error: "upstream failed",
    });
  });

  it("stops a timed-out turn, scores it an error and continues once it stopped", async () => {
    mocks.agentEvalQuestion.findMany.mockResolvedValue([
      question,
      { ...question, id: "q2" },
    ]);
    mocks.turn.findUniqueOrThrow.mockResolvedValue({
      status: "running",
      error: null,
    });
    mocks.abortTurn.mockImplementation(async () => {
      mocks.turn.findUniqueOrThrow.mockResolvedValue({
        status: "done",
        error: null,
      });
      return { aborted: true, delivered: true };
    });
    await start();
    await finish();
    expect(mocks.abortTurn).toHaveBeenCalledWith("workspace", "turn1", "user");
    expect(saved.status).toBe("done");
    expect(saved.results.map((r) => [r.outcome, r.error])).toEqual([
      ["error", "Timed out"],
      ["passed", null],
    ]);
  });

  it("fails the run, asking nothing more, when a timed-out turn will not stop", async () => {
    mocks.agentEvalQuestion.findMany.mockResolvedValue([
      question,
      { ...question, id: "q2" },
    ]);
    mocks.turn.findUniqueOrThrow.mockResolvedValue({
      status: "running",
      error: null,
    });
    mocks.abortTurn.mockRejectedValue(
      new ServiceError("CONFLICT", "abort unavailable"),
    );
    await start();
    await finish();
    expect(mocks.createTurn).toHaveBeenCalledTimes(1);
    expect(saved.status).toBe("failed");
    expect(saved.results[0]).toMatchObject({
      outcome: "error",
      turnId: "turn1",
    });
    expect(saved.results[0]?.error).toContain("abort unavailable");
    expect(saved.results[0]?.error).toContain("did not stop");
  });

  it("scores a failed evidence read as an error and keeps the identifiers", async () => {
    mocks.getEvalRunEvidence.mockRejectedValue(
      new ServiceError("NOT_FOUND", "Eval run not found"),
    );
    await start();
    await finish();
    expect(saved.results[0]).toMatchObject({
      outcome: "error",
      turnId: "turn1",
      conversationId: "conversation1",
      error: "Eval run not found",
    });
  });

  it("never shows an internal error's text on a run", async () => {
    mocks.getEvalRunEvidence.mockRejectedValue(
      new Error('connect ECONNREFUSED 10.0.0.5:5432 (relation "turns")'),
    );
    await start();
    await finish();
    expect(saved.results[0]?.outcome).toBe("error");
    expect(saved.results[0]?.error).toBe("Something unexpected went wrong.");
  });

  it("scores a failed turn creation as an error and carries on", async () => {
    mocks.agentEvalQuestion.findMany.mockResolvedValue([
      question,
      { ...question, id: "q2" },
    ]);
    mocks.createTurn
      .mockRejectedValueOnce(new ServiceError("CONFLICT", "dispatch failed"))
      .mockResolvedValue({ id: "turn2" });
    await start();
    await finish();
    expect(saved.status).toBe("done");
    expect(saved.results[0]).toMatchObject({
      outcome: "error",
      conversationId: "conversation1",
      turnId: null,
      error: "dispatch failed",
    });
    expect(saved.results[1]).toMatchObject({ outcome: "passed" });
  });

  it("stops writing once recovery has ended the run", async () => {
    mocks.agentEvalQuestion.findMany.mockResolvedValue([
      question,
      { ...question, id: "q2" },
    ]);
    mocks.createTurn.mockImplementation(async () => {
      runActive = false;
      return { id: "turn1" };
    });
    await start();
    await finish();
    expect(mocks.createTurn).toHaveBeenCalledTimes(1);
    expect(saved.status).toBe("running");
  });
});
