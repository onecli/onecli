import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "../types";

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
  RUNS_PAGE_MAX: 100,
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
// Keep the real audit writer so failure tests exercise its opt-in fail-closed path.
vi.mock("../lib/logger", () => ({
  logger: { child: () => ({ error: vi.fn() }) },
}));
vi.mock("../lib/gateway-invalidate", () => ({
  invalidateGatewayCacheForAccount: vi.fn(),
  invalidateGatewayCacheForOrg: vi.fn(),
}));

const { agentRunRoutes } = await import("./agent-runs");
const { recordAuditEvent, AUDIT_ACTIONS, AUDIT_SERVICES } =
  await import("../services/audit-service");
const app = agentRunRoutes();
app.onError((_err, c) => c.json({ error: "Internal error" }, 500));
const privateRun = {
  turnId: "turn",
  conversationId: "conv",
  question: "sensitive-question",
  answer: "sensitive-answer",
  error: "sensitive-error",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auditCreate.mockResolvedValue({});
  mocks.listRuns.mockResolvedValue({
    runs: [privateRun],
    nextBefore: null,
    isAdmin: true,
    viewedOthersDirect: [{ turnId: "turn", conversationId: "conv" }],
  });
  mocks.getRun.mockResolvedValue({ run: privateRun, viewedOthersDirect: true });
});

describe("Runs private read audit", () => {
  it("accepts emitted compound pagination cursors at the HTTP boundary", async () => {
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
  it.each(["/agent/runs", "/agent/runs/turn"])(
    "audits %s with IDs only before returning content",
    async (path) => {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("sensitive-question");
      expect(mocks.auditCreate).toHaveBeenCalledOnce();
      const data = mocks.auditCreate.mock.calls[0]![0].data;
      expect(data).toMatchObject({
        workspaceId: "ws",
        userId: "viewer",
        action: AUDIT_ACTIONS.VIEW,
        service: AUDIT_SERVICES.CONVERSATION,
      });
      expect(data.metadata.agentId).toBe("agent");
      expect(JSON.stringify(data)).not.toContain("sensitive-");
    },
  );

  it.each(["/agent/runs", "/agent/runs/turn"])(
    "withholds private content if audit persistence fails on %s",
    async (path) => {
      mocks.auditCreate.mockRejectedValueOnce(new Error("audit unavailable"));
      const response = await app.request(path);
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("sensitive-");
    },
  );

  it("does not expose internal list audit descriptors in the response", async () => {
    const response = await app.request("/agent/runs");
    expect(await response.json()).not.toHaveProperty("viewedOthersDirect");
  });

  it("does not audit own or public reads as private overrides", async () => {
    mocks.listRuns.mockResolvedValueOnce({
      runs: [],
      nextBefore: null,
      isAdmin: false,
      viewedOthersDirect: [],
    });
    mocks.getRun.mockResolvedValueOnce({
      run: privateRun,
      viewedOthersDirect: false,
    });
    expect((await app.request("/agent/runs")).status).toBe(200);
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
