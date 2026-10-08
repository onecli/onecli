import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "../types";

/**
 * The RUNS HTTP contract: query validation at the boundary (the house 422),
 * the workspace and per-agent list doors, and the one audited read (opening
 * a colleague's private run). Lists carry no private content, so listing is
 * never audited. The DB laws (fencing, viewer scope) live in
 * agent-runs-service.pg.test.ts; the service is mocked here.
 */

const mocks = vi.hoisted(() => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  auditCreate: vi.fn(),
}));
vi.mock("@onecli/db", () => ({
  Prisma: { JsonNull: null },
  db: { auditLog: { create: mocks.auditCreate } },
}));
vi.mock("../services/agent-runs-service", () => ({
  listRuns: mocks.listRuns,
  getRun: mocks.getRun,
}));
vi.mock("../middleware/auth", () => ({
  authMiddleware: (async (c, next) => {
    c.set("auth", {
      userId: "viewer",
      userEmail: "viewer@example.com",
      organizationId: "org",
      workspaceId: "ws",
    });
    await next();
  }) satisfies MiddlewareHandler<ApiEnv>,
  requireWorkspaceId: () => "ws",
}));
// Keep the real audit writer so failure tests exercise its opt-in fail-closed
// path, and the real error handler so status codes are the house ones.
vi.mock("../lib/logger", () => ({
  logger: { child: () => ({ error: vi.fn() }), error: vi.fn() },
}));
vi.mock("../lib/gateway-invalidate", () => ({
  invalidateGatewayCacheForAccount: vi.fn(),
  invalidateGatewayCacheForOrg: vi.fn(),
}));

const { agentRunRoutes, workspaceRunRoutes } = await import("./agent-runs");
const { errorHandler } = await import("../middleware/error-handler");
const { recordAuditEvent, AUDIT_ACTIONS, AUDIT_SERVICES } =
  await import("../services/audit-service");
const app = agentRunRoutes();
app.onError(errorHandler);
const wsApp = workspaceRunRoutes();
wsApp.onError(errorHandler);

const privateRun = {
  turnId: "turn",
  conversationId: "conv",
  question: "sensitive-question",
  answer: "sensitive-answer",
  error: "sensitive-error",
};
const page = {
  runs: [{ turnId: "turn", private: true }],
  nextBefore: null,
  isAdmin: true,
  appEvidenceWithheld: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auditCreate.mockResolvedValue({});
  mocks.listRuns.mockResolvedValue(page);
  mocks.getRun.mockResolvedValue({ run: privateRun, viewedOthersDirect: true });
});

describe("Runs lists", () => {
  it("GET /v1/runs lists the whole workspace, with the parsed filters", async () => {
    const response = await wsApp.request("/?failed=true&source=web");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(page);
    expect(mocks.listRuns).toHaveBeenCalledWith("ws", "org", "viewer", null, {
      failedOnly: true,
      source: "web",
    });
  });

  it("accepts emitted compound pagination cursors on the agent list", async () => {
    const before = "2026-09-01T12:00:00.000Z~turn-id";
    const response = await app.request(
      `/agent/runs?before=${encodeURIComponent(before)}`,
    );
    expect(response.status).toBe(200);
    expect(mocks.listRuns).toHaveBeenCalledWith(
      "ws",
      "org",
      "viewer",
      "agent",
      expect.objectContaining({ before }),
    );
  });

  it.each(["/?limit=0", "/?failed=yes", `/?source=${"s".repeat(41)}`])(
    "answers an invalid query (%s) with a 422 before reading",
    async (path) => {
      const response = await wsApp.request(path);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: { type: "validation_error" },
      });
      expect(mocks.listRuns).not.toHaveBeenCalled();
    },
  );

  it.each(["/", "/agent/runs"])(
    "never audits a list read (%s), even one naming a colleague's private run",
    async (path) => {
      const target = path === "/" ? wsApp : app;
      expect((await target.request(path)).status).toBe(200);
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    },
  );
});

describe("Runs private read audit (detail)", () => {
  it("audits a colleague's private run with IDs only before returning it", async () => {
    const response = await app.request("/agent/runs/turn");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("sensitive-question");
    expect(mocks.auditCreate).toHaveBeenCalledOnce();
    const data = mocks.auditCreate.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      workspaceId: "ws",
      userId: "viewer",
      action: AUDIT_ACTIONS.VIEW,
      service: AUDIT_SERVICES.CONVERSATION,
      metadata: {
        agentId: "agent",
        surface: "runs.detail",
        turnId: "turn",
        conversationId: "conv",
      },
    });
    expect(JSON.stringify(data)).not.toContain("sensitive-");
  });

  it("withholds the run if audit persistence fails", async () => {
    mocks.auditCreate.mockRejectedValueOnce(new Error("audit unavailable"));
    const response = await app.request("/agent/runs/turn");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("sensitive-");
  });

  it("does not audit an own or shared run", async () => {
    mocks.getRun.mockResolvedValueOnce({
      run: privateRun,
      viewedOthersDirect: false,
    });
    expect((await app.request("/agent/runs/turn")).status).toBe(200);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("preserves existing best-effort audit behavior unless explicitly opted in", async () => {
    mocks.auditCreate.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(
      recordAuditEvent({
        userId: "viewer",
        userEmail: "viewer@example.com",
        action: AUDIT_ACTIONS.VIEW,
        service: AUDIT_SERVICES.CONVERSATION,
      }),
    ).resolves.toBeUndefined();
  });
});
