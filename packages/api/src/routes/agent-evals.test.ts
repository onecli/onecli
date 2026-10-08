import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The agent EVALS HTTP contract: token families, status codes, body
 * validation at the boundary, and audit records that carry IDs only. The
 * DB laws (admission, the cap, tenancy) live in agent-eval-service.pg.test.ts;
 * the service is mocked here.
 */

const ORG_KEY = "oc_org_test-key";
const RUNNER_TOKEN = "rnr_a-runner";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

const mocks = vi.hoisted(() => ({
  listQuestions: vi.fn(),
  listRuns: vi.fn(),
  saveQuestion: vi.fn(),
  archiveQuestion: vi.fn(),
  startRun: vi.fn(),
  getRun: vi.fn(),
  auditCreate:
    vi.fn<(arg: { data: Record<string, unknown> }) => Promise<unknown>>(),
}));

vi.mock("@onecli/db", () => ({
  Prisma: { JsonNull: null },
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === ORG_KEY
          ? { userId: "user-1", organizationId: "org-1", scope: "organization" }
          : null,
      findFirst: async () => null,
    },
    runner: {
      findUnique: async ({ where }: { where: { token: string } }) =>
        where.token === RUNNER_TOKEN ? { id: "r-1", name: "laptop" } : null,
    },
    user: { findUnique: async () => ({ email: "admin@example.com" }) },
    organizationMember: {
      findUnique: async () => ({
        organizationId: "org-1",
        userId: "user-1",
        role: "owner",
      }),
    },
    workspace: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        where.id === "p1" ? { id: "p1" } : null,
    },
    auditLog: { create: mocks.auditCreate },
  },
}));

vi.mock("../services/agent-eval-service", () => ({
  listQuestions: mocks.listQuestions,
  listRuns: mocks.listRuns,
  saveQuestion: mocks.saveQuestion,
  archiveQuestion: mocks.archiveQuestion,
  startRun: mocks.startRun,
  getRun: mocks.getRun,
}));

const { createApiApp } = await import("../app");
const { ServiceError } = await import("../services/errors");

const app = createApiApp({ getSession: async () => null });

const AUTH = {
  authorization: `Bearer ${ORG_KEY}`,
  "x-workspace-id": "p1",
  "content-type": "application/json",
};

const QUESTION = {
  question: "How many customers do we have?",
  expected: "42",
  kind: "numeric",
  expectedApps: [],
};

const send = (path: string, method: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: AUTH,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

const auditRows = () => mocks.auditCreate.mock.calls.map(([arg]) => arg.data);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auditCreate.mockResolvedValue({});
  mocks.listQuestions.mockResolvedValue([]);
  mocks.listRuns.mockResolvedValue([]);
  mocks.saveQuestion.mockResolvedValue({ id: "q-1", ...QUESTION });
  mocks.archiveQuestion.mockResolvedValue(undefined);
  mocks.startRun.mockResolvedValue({ id: "run-1", total: 3 });
  mocks.getRun.mockResolvedValue({ id: "run-1" });
});

describe("authentication", () => {
  it.each([
    ["/v1/agents/ag-1/evals", "GET"],
    ["/v1/agents/ag-1/evals/questions", "POST"],
    ["/v1/agents/ag-1/evals/questions/q-1", "PUT"],
    ["/v1/agents/ag-1/evals/questions/q-1", "DELETE"],
    ["/v1/agents/ag-1/evals/runs", "POST"],
    ["/v1/agents/ag-1/evals/runs/run-1", "GET"],
  ])("refuses %s %s without credentials", async (path, method) => {
    const res = await app.request(path, { method });
    expect(res.status).toBe(401);
  });

  it("refuses a RUNNER token: token families do not cross", async () => {
    const res = await app.request("/v1/agents/ag-1/evals/runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${RUNNER_TOKEN}`,
        "x-workspace-id": "p1",
      },
    });
    expect(res.status).toBe(401);
    expect(mocks.startRun).not.toHaveBeenCalled();
  });

  it("refuses an org key that names no workspace", async () => {
    const res = await app.request("/v1/agents/ag-1/evals", {
      headers: { authorization: `Bearer ${ORG_KEY}` },
    });
    expect(res.status).toBe(401);
    expect(mocks.listQuestions).not.toHaveBeenCalled();
  });
});

describe("questions", () => {
  it("lists questions and runs with the cap, scoped to the workspace", async () => {
    const res = await send("/v1/agents/ag-1/evals", "GET");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      questions: [],
      runs: [],
      maxQuestions: 50,
    });
    expect(mocks.listQuestions).toHaveBeenCalledWith("p1", "ag-1");
    expect(mocks.listRuns).toHaveBeenCalledWith("p1", "ag-1");
  });

  it("creates with 201 and audits IDs only, never the question text", async () => {
    const res = await send("/v1/agents/ag-1/evals/questions", "POST", QUESTION);
    expect(res.status).toBe(201);
    expect(mocks.saveQuestion).toHaveBeenCalledWith(
      "p1",
      "ag-1",
      null,
      QUESTION,
    );
    const [row] = auditRows();
    expect(row).toMatchObject({ action: "create", service: "eval" });
    expect(JSON.stringify(row)).not.toContain(QUESTION.question);
  });

  it.each([
    ["no body", undefined],
    ["an empty question", { ...QUESTION, question: "  " }],
    [
      "a number check that is not one number",
      { ...QUESTION, expected: "about 3 million in 2024" },
    ],
    ["an unknown check kind", { ...QUESTION, kind: "semantic" }],
    [
      "too many apps",
      {
        ...QUESTION,
        expectedApps: Array.from({ length: 21 }, (_, i) => `a${i}`),
      },
    ],
  ])("refuses %s with 422 before reaching the service", async (_, body) => {
    const res = await send("/v1/agents/ag-1/evals/questions", "POST", body);
    expect(res.status).toBe(422);
    expect(mocks.saveQuestion).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("edits with PUT and archives with 204", async () => {
    expect(
      (await send("/v1/agents/ag-1/evals/questions/q-1", "PUT", QUESTION))
        .status,
    ).toBe(200);
    expect(mocks.saveQuestion).toHaveBeenCalledWith(
      "p1",
      "ag-1",
      "q-1",
      QUESTION,
    );
    const res = await send("/v1/agents/ag-1/evals/questions/q-1", "DELETE");
    expect(res.status).toBe(204);
    expect(mocks.archiveQuestion).toHaveBeenCalledWith("p1", "ag-1", "q-1");
    expect(auditRows().map((r) => r.action)).toEqual(["update", "delete"]);
  });

  it("maps a missing question to 404 and writes no audit row", async () => {
    mocks.archiveQuestion.mockRejectedValue(
      new ServiceError("NOT_FOUND", "Test question not found"),
    );
    const res = await send("/v1/agents/ag-1/evals/questions/q-x", "DELETE");
    expect(res.status).toBe(404);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

describe("runs", () => {
  it("starts a run with 202 and audits it", async () => {
    const res = await send("/v1/agents/ag-1/evals/runs", "POST");
    expect(res.status).toBe(202);
    expect(mocks.startRun).toHaveBeenCalledWith(
      "p1",
      "org-1",
      "user-1",
      "ag-1",
    );
    expect(auditRows()).toEqual([
      expect.objectContaining({
        action: "run",
        service: "eval",
        metadata: { agentId: "ag-1", runId: "run-1", questions: 3 },
      }),
    ]);
  });

  it("maps a second run while one is active to 409", async () => {
    mocks.startRun.mockRejectedValue(
      new ServiceError("CONFLICT", "Tests are already running"),
    );
    const res = await send("/v1/agents/ag-1/evals/runs", "POST");
    expect(res.status).toBe(409);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("reads one run, scoped to the workspace and agent", async () => {
    const res = await send("/v1/agents/ag-1/evals/runs/run-1", "GET");
    expect(res.status).toBe(200);
    expect(mocks.getRun).toHaveBeenCalledWith("p1", "ag-1", "run-1");
  });
});
