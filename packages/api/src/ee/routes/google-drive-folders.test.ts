import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiEnv } from "../../types";
import { errorHandler } from "../../middleware/error-handler";

// The real router with session auth and the service stubbed: the org id the
// service receives comes from AUTH (never the query), missing connectionId is
// a 400, and service errors map to HTTP status through the app error handler.

const svc = vi.hoisted(() => ({
  listGoogleDriveFolders: vi.fn(),
  resolveGoogleDriveFolderNames: vi.fn(),
}));
vi.mock("../services/google-drive-folder-service", () => svc);
vi.mock("../middleware/enterprise-gate", () => ({
  requireEnterprise: (): MiddlewareHandler<ApiEnv> => async (_c, next) =>
    next(),
}));
vi.mock("../../middleware/auth", () => ({
  auth: (): MiddlewareHandler<ApiEnv> => async (c, next) => {
    c.set("auth", {
      userId: "u1",
      organizationId: "org-from-auth",
      workspaceId: "ws-from-auth",
    } as never);
    await next();
  },
}));

const { googleDriveFolderRoutes } = await import("./google-drive-folders");

const app = () => {
  const a = new Hono<ApiEnv>();
  a.route("/", googleDriveFolderRoutes());
  a.onError(errorHandler);
  return a;
};

describe("google drive folder routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists folders for the caller's org, ignoring any org in the query", async () => {
    svc.listGoogleDriveFolders.mockResolvedValue([
      { id: "f1", name: "Clients", kind: "folder" },
    ]);
    const res = await app().request(
      "/folders?connectionId=c1&parentId=p1&organizationId=evil",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: "f1", name: "Clients", kind: "folder" },
    ]);
    expect(svc.listGoogleDriveFolders).toHaveBeenCalledWith(
      { organizationId: "org-from-auth", workspaceId: "ws-from-auth" },
      "c1",
      "p1",
    );
  });

  it("treats an empty parentId as the top level", async () => {
    svc.listGoogleDriveFolders.mockResolvedValue([]);
    await app().request("/folders?connectionId=c1&parentId=");
    expect(svc.listGoogleDriveFolders).toHaveBeenCalledWith(
      { organizationId: "org-from-auth", workspaceId: "ws-from-auth" },
      "c1",
      undefined,
    );
  });

  it("requires connectionId, in the app-wide error shape", async () => {
    for (const path of ["/folders", "/folder-names?ids=a"]) {
      const res = await app().request(path);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: { message: "connectionId is required" },
      });
    }
    expect(svc.listGoogleDriveFolders).not.toHaveBeenCalled();
    expect(svc.resolveGoogleDriveFolderNames).not.toHaveBeenCalled();
  });

  it("maps a connection outside the org to 404", async () => {
    const { ServiceError } = await import("../../services/errors");
    svc.listGoogleDriveFolders.mockRejectedValue(
      new ServiceError("NOT_FOUND", "Connection not found"),
    );
    expect(
      (await app().request("/folders?connectionId=other-org")).status,
    ).toBe(404);
  });

  it("resolves folder names", async () => {
    svc.resolveGoogleDriveFolderNames.mockResolvedValue({ a: "A", b: null });
    const res = await app().request("/folder-names?connectionId=c1&ids=a,b");
    expect(await res.json()).toEqual({ a: "A", b: null });
    expect(svc.resolveGoogleDriveFolderNames).toHaveBeenCalledWith(
      { organizationId: "org-from-auth", workspaceId: "ws-from-auth" },
      "c1",
      ["a", "b"],
    );
  });
});
