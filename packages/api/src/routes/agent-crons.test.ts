import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The schedules HTTP contract (step 7). The DB laws — claims, fences, the
 * fire path — live in services/cron.pg.test.ts; services are mocked here so
 * this file is about status codes, validation, the origin threading on
 * create, and the token-family fences in BOTH directions (a user key must
 * never drive the runner tool-call relay; a runner token must never drive
 * the dashboard surface).
 */

const ORG_KEY = "oc_org_test-key";
const RUNNER_TOKEN = "rnr_a-runner";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

const services = vi.hoisted(() => ({
  createCron: vi.fn(),
  listCrons: vi.fn(),
  updateCron: vi.fn(),
  deleteCron: vi.fn(),
  runCronNow: vi.fn(),
  ensureDirectConversation: vi.fn(),
  executePlatformTool: vi.fn(),
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
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
      // The middleware's fire-and-forget lastSeenAt touch.
      update: async () => ({}),
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
    auditLog: { create: async () => ({}) },
  },
}));

vi.mock("../services/agent-cron-service", () => ({
  createCron: services.createCron,
  listCrons: services.listCrons,
  updateCron: services.updateCron,
  deleteCron: services.deleteCron,
  runCronNow: services.runCronNow,
  // Real co-importers of the mocked module (turn-service, cron-fire) still
  // need these named exports to exist.
  computeNextFire: vi.fn(),
  disableCron: vi.fn(),
  CRON_FAILURE_DISABLE_THRESHOLD: 5,
}));

vi.mock("../services/conversation-service", () => ({
  ensureDirectConversation: services.ensureDirectConversation,
  ensureSourcedConversation: vi.fn(),
  requireConversation: vi.fn(),
  requireSystemConversation: vi.fn(),
}));

vi.mock("../services/platform-tool-service", () => ({
  executePlatformTool: services.executePlatformTool,
}));

const { createApiApp } = await import("../app");
const { ServiceError } = await import("../services/errors");

const app = createApiApp({ getSession: async () => null });

const AUTH = {
  authorization: `Bearer ${ORG_KEY}`,
  "x-workspace-id": "p1",
  "content-type": "application/json",
};

const CRON = {
  id: "cr-1",
  agentId: "ag-1",
  name: "daily",
  prompt: "do it",
  schedule: "0 9 * * *",
  timezone: "UTC",
  enabled: true,
  disabledReason: null,
  nextFireAt: new Date("2026-08-08T09:00:00Z"),
  lastFiredAt: null,
  lastOutcome: null,
  consecutiveFailures: 0,
  createdAt: new Date("2026-08-07T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  services.listCrons.mockResolvedValue([CRON]);
  services.createCron.mockResolvedValue(CRON);
  services.updateCron.mockResolvedValue(CRON);
  services.runCronNow.mockResolvedValue(CRON);
  services.deleteCron.mockResolvedValue(undefined);
  services.ensureDirectConversation.mockResolvedValue({ id: "conv-origin" });
  services.executePlatformTool.mockResolvedValue({ ok: true, result: {} });
});

describe("the dashboard surface", () => {
  it("lists the agent's schedules", async () => {
    const response = await app.request("/v1/agents/ag-1/crons", {
      headers: AUTH,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { crons: unknown[] };
    expect(body.crons).toHaveLength(1);
    expect(services.listCrons).toHaveBeenCalledWith("p1", "ag-1");
  });

  it("create anchors the origin to the CREATOR's direct thread", async () => {
    const response = await app.request("/v1/agents/ag-1/crons", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        name: "daily",
        prompt: "do it",
        schedule: "0 9 * * *",
        timezone: "UTC",
      }),
    });
    expect(response.status).toBe(201);
    // The delivery-follows-origin decision, at the HTTP layer: dashboard
    // create resolves the creating user's thread first.
    expect(services.ensureDirectConversation).toHaveBeenCalledWith(
      "p1",
      "ag-1",
      "user-1",
    );
    expect(services.createCron).toHaveBeenCalledWith(
      "p1",
      "ag-1",
      expect.objectContaining({ name: "daily" }),
      { originConversationId: "conv-origin", createdByUserId: "user-1" },
    );
  });

  it("refuses an empty update and an unknown body key", async () => {
    const empty = await app.request("/v1/agents/ag-1/crons/cr-1", {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(422);

    const unknown = await app.request("/v1/agents/ag-1/crons/cr-1", {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({ nextFireAt: "2026-01-01" }),
    });
    expect(unknown.status).toBe(422);
    expect(services.updateCron).not.toHaveBeenCalled();
  });

  it("passes a service NOT_FOUND through as 404", async () => {
    services.runCronNow.mockRejectedValue(
      new ServiceError("NOT_FOUND", "Schedule not found"),
    );
    const response = await app.request("/v1/agents/ag-1/crons/cr-x/run", {
      method: "POST",
      headers: AUTH,
      body: "{}",
    });
    expect(response.status).toBe(404);
  });

  it("deletes with 204", async () => {
    const response = await app.request("/v1/agents/ag-1/crons/cr-1", {
      method: "DELETE",
      headers: AUTH,
    });
    expect(response.status).toBe(204);
    expect(services.deleteCron).toHaveBeenCalledWith("p1", "ag-1", "cr-1");
  });

  it("a runner token never drives the dashboard surface", async () => {
    const response = await app.request("/v1/agents/ag-1/crons", {
      headers: {
        authorization: `Bearer ${RUNNER_TOKEN}`,
        "x-workspace-id": "p1",
      },
    });
    expect(response.status).toBe(401);
  });
});

describe("the runner tool-call relay", () => {
  it("relays under a runner token and returns the tool outcome verbatim", async () => {
    services.executePlatformTool.mockResolvedValue({
      ok: false,
      error: "This tool is not available.",
    });
    const response = await app.request("/v1/runner/tool-call", {
      method: "POST",
      headers: {
        authorization: `Bearer ${RUNNER_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sandboxId: "sb-1", tool: "list_tasks", args: {} }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      error: "This tool is not available.",
    });
    expect(services.executePlatformTool).toHaveBeenCalledWith(
      "r-1",
      expect.objectContaining({ sandboxId: "sb-1", tool: "list_tasks" }),
    );
  });

  it("a user API key never drives the relay — mirror image of the family fence", async () => {
    const response = await app.request("/v1/runner/tool-call", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ sandboxId: "sb-1", tool: "list_tasks", args: {} }),
    });
    expect(response.status).toBe(401);
    expect(services.executePlatformTool).not.toHaveBeenCalled();
  });

  it("rejects a malformed relay body before it reaches the service", async () => {
    const response = await app.request("/v1/runner/tool-call", {
      method: "POST",
      headers: {
        authorization: `Bearer ${RUNNER_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tool: "list_tasks" }),
    });
    expect(response.status).toBe(400);
    expect(services.executePlatformTool).not.toHaveBeenCalled();
  });
});
