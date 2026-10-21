import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "../types";

/**
 * The USAGE HTTP contract: the window is validated at the boundary (UTC
 * dates, house 422), the agent read is a workspace member's door and the
 * org read an org admin's with no workspace, and the service receives
 * exactly the caller's own org/workspace from the auth context, never from
 * input. The DB laws (fencing, arithmetic) live in runtime-ledger.pg.test.ts;
 * the service is mocked here.
 */

const mocks = vi.hoisted(() => ({
  getAgentRuntimeUsage: vi.fn(),
  getOrgRuntimeUsage: vi.fn(),
  authOptions: [] as unknown[],
}));
vi.mock("../services/runtime-usage-service", () => ({
  getAgentRuntimeUsage: mocks.getAgentRuntimeUsage,
  getOrgRuntimeUsage: mocks.getOrgRuntimeUsage,
}));
vi.mock("../middleware/auth", () => {
  const set = (async (c, next) => {
    c.set("auth", {
      userId: "viewer",
      userEmail: "viewer@example.com",
      organizationId: "org",
      workspaceId: "ws",
    });
    await next();
  }) satisfies MiddlewareHandler<ApiEnv>;
  return {
    authMiddleware: set,
    auth: (options: unknown) => {
      mocks.authOptions.push(options);
      return set;
    },
    requireWorkspaceId: () => "ws",
  };
});
vi.mock("../lib/logger", () => ({
  logger: { child: () => ({ error: vi.fn() }), error: vi.fn() },
}));

const { agentUsageRoutes, usageRoutes } = await import("./usage");
const { errorHandler } = await import("../middleware/error-handler");
const agentApp = agentUsageRoutes();
agentApp.onError(errorHandler);
const orgApp = usageRoutes();
orgApp.onError(errorHandler);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAgentRuntimeUsage.mockResolvedValue({
    agentId: "agent",
    awakeSeconds: 42,
    running: false,
  });
  mocks.getOrgRuntimeUsage.mockResolvedValue({ agents: [], awakeSeconds: 0 });
});

describe("GET /v1/agents/:agentId/usage", () => {
  it("reads the caller's own workspace and org, and the window from the query", async () => {
    const res = await agentApp.request(
      "/agent-1/usage?from=2026-01-01&to=2026-01-31",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ awakeSeconds: 42 });
    const [workspaceId, organizationId, agentId, window] =
      mocks.getAgentRuntimeUsage.mock.calls[0] ?? [];
    expect([workspaceId, organizationId, agentId]).toEqual([
      "ws",
      "org",
      "agent-1",
    ]);
    expect(window.from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(window.to.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("defaults to all time up to now", async () => {
    await agentApp.request("/agent-1/usage");
    const window = mocks.getAgentRuntimeUsage.mock.calls[0]?.[3];
    expect(window.from.getTime()).toBe(0);
    expect(window.to.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("422s a bad or inverted window before touching the service", async () => {
    expect((await agentApp.request("/a/usage?from=yesterday")).status).toBe(
      422,
    );
    expect(
      (await agentApp.request("/a/usage?from=2026-02-01&to=2026-01-01")).status,
    ).toBe(422);
    expect(mocks.getAgentRuntimeUsage).not.toHaveBeenCalled();
  });

  it("surfaces the service's 404 for a foreign agent as the house 404", async () => {
    const { ServiceError } = await import("../services/errors");
    mocks.getAgentRuntimeUsage.mockRejectedValue(
      new ServiceError("NOT_FOUND", "Agent not found"),
    );
    expect((await agentApp.request("/theirs/usage")).status).toBe(404);
  });
});

describe("GET /v1/usage/runtime", () => {
  it("is an org-admin door with no workspace, reading the caller's org", async () => {
    // The router asked for exactly this gate when it was built.
    expect(mocks.authOptions).toContainEqual({
      requireWorkspace: false,
      role: "admin",
    });
    const res = await orgApp.request("/runtime?from=2026-03-01");
    expect(res.status).toBe(200);
    const [organizationId, window] =
      mocks.getOrgRuntimeUsage.mock.calls[0] ?? [];
    expect(organizationId).toBe("org");
    expect(window.from.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("422s a bad window", async () => {
    expect((await orgApp.request("/runtime?to=soon")).status).toBe(422);
    expect(mocks.getOrgRuntimeUsage).not.toHaveBeenCalled();
  });
});
