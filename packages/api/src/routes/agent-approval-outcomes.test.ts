import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "../types";

/**
 * The approval-outcomes HTTP contract: ids validated at the boundary (the
 * house 422), and the caller's own workspace and org handed to the service
 * (which fences on them; its DB laws live in the pg suite).
 */

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../services/approval-outcome-service", () => ({
  listApprovalOutcomes: mocks.list,
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
vi.mock("../lib/logger", () => ({
  logger: { child: () => ({ error: vi.fn() }), error: vi.fn() },
}));

const { agentApprovalOutcomeRoutes } =
  await import("./agent-approval-outcomes");
const { errorHandler } = await import("../middleware/error-handler");
const app = agentApprovalOutcomeRoutes();
app.onError(errorHandler);

const A = "6f03eba7-fa0f-4234-a9a6-f0cd3d93eb7f";
const B = "744af444-2fa9-48d6-98bb-ac84b35cc5e8";

beforeEach(() => {
  mocks.list.mockReset();
  mocks.list.mockResolvedValue([]);
});

describe("GET /agents/:agentId/approval-outcomes", () => {
  it("passes the caller's workspace, org, agent and ids to the service", async () => {
    const res = await app.request(`/ag-1/approval-outcomes?ids=${A},${B}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcomes: [] });
    expect(mocks.list).toHaveBeenCalledWith({
      workspaceId: "ws",
      organizationId: "org",
      agentId: "ag-1",
      approvalIds: [A, B],
    });
  });

  it.each([
    ["no ids", "/ag-1/approval-outcomes"],
    ["an empty list", "/ag-1/approval-outcomes?ids="],
    ["a non-uuid id", "/ag-1/approval-outcomes?ids=not-an-id"],
    [
      "more ids than one read answers",
      `/ag-1/approval-outcomes?ids=${Array.from({ length: 51 }, () => A).join(",")}`,
    ],
  ])("refuses %s with 422", async (_label, path) => {
    const res = await app.request(path);
    expect(res.status).toBe(422);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
