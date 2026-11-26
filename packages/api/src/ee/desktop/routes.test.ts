import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The desktop routes' HTTP contract on the hosted platform: the resource
 * shape, the status codes, who the actor is, and that the service's errors
 * reach the wire as the right statuses. The service's own rules (the lease,
 * the hand-back, the fences) are proven against PostgreSQL in
 * service.pg.test.ts. Off cloud the whole surface is absent: that arm is
 * routes.onprem.test.ts (`IS_CLOUD` is frozen at module load, so the two
 * cannot share a file).
 */

const ORG_KEY = "oc_org_test-key";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  delete process.env.EDITION;
});

const services = vi.hoisted(() => ({
  desktopFor: vi.fn(),
  wakeDesktop: vi.fn(),
  takeControl: vi.fn(),
  releaseControl: vi.fn(),
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
    runner: { findUnique: async () => null, update: async () => ({}) },
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

vi.mock("./service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./service")>()),
  desktopFor: services.desktopFor,
  wakeDesktop: services.wakeDesktop,
  takeControl: services.takeControl,
  releaseControl: services.releaseControl,
}));

const { createApiApp } = await import("../../app");
const { ServiceError } = await import("../../services/errors");

const app = createApiApp({ getSession: async () => null });

const AUTH = {
  authorization: `Bearer ${ORG_KEY}`,
  "x-workspace-id": "p1",
  "content-type": "application/json",
};

const STATE = {
  available: true,
  sandboxState: "awake",
  viewHost: "d-agent-ab12.preview.test",
  controlHost: null,
  controller: null,
  request: null,
  you: { controlling: false },
};

const ACTOR = {
  userId: "user-1",
  userEmail: "admin@example.com",
  organizationId: "org-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  services.desktopFor.mockResolvedValue(STATE);
  services.wakeDesktop.mockResolvedValue(undefined);
  services.takeControl.mockResolvedValue({
    ...STATE,
    controlHost: "d-agent-ab12-ctl.preview.test",
    you: { controlling: true },
  });
  services.releaseControl.mockResolvedValue(STATE);
});

describe("GET /v1/agents/:id/desktop", () => {
  it("answers the state for the signed-in viewer in the named workspace", async () => {
    const res = await app.request("/v1/agents/ag-1/desktop", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(STATE);
    expect(services.desktopFor).toHaveBeenCalledWith("p1", "ag-1", "user-1");
  });

  it("401s without credentials", async () => {
    const res = await app.request("/v1/agents/ag-1/desktop");
    expect(res.status).toBe(401);
    expect(services.desktopFor).not.toHaveBeenCalled();
  });

  it("maps the service's not-found to 404", async () => {
    services.desktopFor.mockRejectedValue(
      new ServiceError("NOT_FOUND", "Agent not found"),
    );
    const res = await app.request("/v1/agents/ag-x/desktop", { headers: AUTH });
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/agents/:id/desktop/wake", () => {
  it("202s with the state as it now stands: the boot is asynchronous", async () => {
    services.desktopFor.mockResolvedValue({
      ...STATE,
      sandboxState: "waking",
      viewHost: null,
    });
    const res = await app.request("/v1/agents/ag-1/desktop/wake", {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ sandboxState: "waking" });
    expect(services.wakeDesktop).toHaveBeenCalledWith("p1", "ag-1");
    expect(services.desktopFor).toHaveBeenCalledWith("p1", "ag-1", "user-1");
  });
});

describe("POST /v1/agents/:id/desktop/control", () => {
  it("takes the lease as the signed-in person and answers the new state", async () => {
    const res = await app.request("/v1/agents/ag-1/desktop/control", {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      controlHost: "d-agent-ab12-ctl.preview.test",
      you: { controlling: true },
    });
    expect(services.takeControl).toHaveBeenCalledWith("p1", "ag-1", ACTOR);
  });

  it("409s when someone else holds it, naming them", async () => {
    services.takeControl.mockRejectedValue(
      new ServiceError("CONFLICT", "Alex Kim is in control"),
    );
    const res = await app.request("/v1/agents/ag-1/desktop/control", {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { message: "Alex Kim is in control" },
    });
  });
});

describe("DELETE /v1/agents/:id/desktop/control", () => {
  it("hands back with no body: the person and the agent are all it needs", async () => {
    const res = await app.request("/v1/agents/ag-1/desktop/control", {
      method: "DELETE",
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(STATE);
    expect(services.releaseControl).toHaveBeenCalledWith("p1", "ag-1", ACTOR);
  });

  it("403s when the service refuses the actor", async () => {
    services.releaseControl.mockRejectedValue(
      new ServiceError("FORBIDDEN", "Only the person in control, or an admin"),
    );
    const res = await app.request("/v1/agents/ag-1/desktop/control", {
      method: "DELETE",
      headers: AUTH,
    });
    expect(res.status).toBe(403);
  });
});
