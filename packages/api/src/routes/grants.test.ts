import { beforeEach, describe, expect, it, vi } from "vitest";

// The grants routes' HTTP contract: auth, param/body validation, status codes,
// and the service-call wiring (services are mocked — their laws live in
// grants-service.test.ts and grants-service.pg.test.ts).

const ORG_KEY = "oc_org_test-key";

vi.hoisted(() => {
  // Pinned oss: CAPS.rbac off, so the org-key auth needs no role resolver —
  // the suite tests the routes' HTTP contract, not role enforcement.
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

const services = vi.hoisted(() => ({
  getAgentGrants: vi.fn(),
  getConnectionGrants: vi.fn(),
  setConnectionGrant: vi.fn(),
  removeConnectionGrant: vi.fn(),
  setSecretGrant: vi.fn(),
  removeSecretGrant: vi.fn(),
  listAgentsWithGrantsSummary: vi.fn(),
  listAgents: vi.fn(),
}));

/** Every audit row the routes write, in order. */
const auditCreate = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === ORG_KEY
          ? { userId: "user-1", organizationId: "org-1", scope: "organization" }
          : null,
      // withAudit's server-side gateway flush borrows a workspace key; none here
      // → the flush no-ops (fire-and-forget), which is what the tests want.
      findFirst: async () => null,
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
    auditLog: { create: auditCreate },
  },
}));

vi.mock("../services/grants-service", () => ({
  getAgentGrants: services.getAgentGrants,
  getConnectionGrants: services.getConnectionGrants,
  setConnectionGrant: services.setConnectionGrant,
  removeConnectionGrant: services.removeConnectionGrant,
  setSecretGrant: services.setSecretGrant,
  removeSecretGrant: services.removeSecretGrant,
}));

vi.mock("../services/grants-summary-service", () => ({
  listAgentsWithGrantsSummary: services.listAgentsWithGrantsSummary,
}));

vi.mock("../services/agent-service", () => ({
  listAgents: services.listAgents,
  createAgent: vi.fn(),
  agentExistsByIdentifier: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  regenerateAgentToken: vi.fn(),
}));

const { createApiApp } = await import("../app");

const app = createApiApp({ getSession: async () => null });

const AUTH = {
  authorization: `Bearer ${ORG_KEY}`,
  "x-workspace-id": "p1",
};
const SCOPE = { workspaceId: "p1", organizationId: "org-1" };
const GRANTS = {
  agentId: "a1",
  mode: "grants",
  connections: [],
  secrets: [],
};

beforeEach(() => {
  for (const fn of Object.values(services)) fn.mockReset();
  auditCreate.mockClear();
  services.getAgentGrants.mockResolvedValue(GRANTS);
  services.setConnectionGrant.mockResolvedValue({
    grants: GRANTS,
    changed: true,
    ruleIds: ["r1"],
    generation: 3,
  });
  services.removeConnectionGrant.mockResolvedValue({
    grants: GRANTS,
    changed: true,
    ruleIds: [],
    generation: 3,
  });
  services.getConnectionGrants.mockResolvedValue({
    connectionId: "c1",
    agents: [],
  });
  services.setSecretGrant.mockResolvedValue({
    grants: GRANTS,
    changed: true,
    ruleIds: ["r2"],
    generation: 3,
  });
  services.removeSecretGrant.mockResolvedValue({
    grants: GRANTS,
    changed: true,
    ruleIds: [],
    generation: 3,
  });
  services.listAgentsWithGrantsSummary.mockResolvedValue([]);
  services.listAgents.mockResolvedValue([]);
});

describe("agent grants routes", () => {
  it("requires auth", async () => {
    const res = await app.request("/v1/agents/a1/grants");
    expect(res.status).toBe(401);
  });

  it("GET returns the agent's grants with the workspace scope", async () => {
    const res = await app.request("/v1/agents/a1/grants", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(GRANTS);
    expect(services.getAgentGrants).toHaveBeenCalledWith(SCOPE, "a1");
  });

  it("PUT rejects a malformed body with 422 and the standard error shape", async () => {
    const res = await app.request("/v1/agents/a1/grants/connections/c1", {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ access: "custom", allow: [], ask: [] }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("detach instead");
    expect(services.setConnectionGrant).not.toHaveBeenCalled();
  });

  it("PUT attaches and returns the updated grants", async () => {
    const res = await app.request("/v1/agents/a1/grants/connections/c1", {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ access: "full" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(GRANTS);
    expect(services.setConnectionGrant).toHaveBeenCalledWith(
      SCOPE,
      "a1",
      "c1",
      { access: "full" },
      "user-1",
    );
  });

  it("PUT carries the catch-all choices through, and rejects an unknown one", async () => {
    const put = (body: unknown) =>
      app.request("/v1/agents/a1/grants/connections/c1", {
        method: "PUT",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const custom = { access: "custom", allow: ["t"], ask: [] };

    expect(
      (await put({ ...custom, otherReads: "allow", otherWrites: "never" }))
        .status,
    ).toBe(200);
    expect(services.setConnectionGrant).toHaveBeenLastCalledWith(
      SCOPE,
      "a1",
      "c1",
      { ...custom, otherReads: "allow", otherWrites: "never" },
      "user-1",
    );

    services.setConnectionGrant.mockClear();
    expect((await put({ ...custom, otherReads: "sometimes" })).status).toBe(
      422,
    );
    expect(services.setConnectionGrant).not.toHaveBeenCalled();
  });

  it("PUT maps the service's AWS-style refusal to a 422 with the standard error shape", async () => {
    const { ServiceError } = await import("../services/errors");
    services.setConnectionGrant.mockRejectedValueOnce(
      new ServiceError(
        "UNPROCESSABLE",
        '"aws" keeps requests outside its tool list closed',
      ),
    );
    const res = await app.request("/v1/agents/a1/grants/connections/c1", {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        access: "custom",
        allow: ["t"],
        ask: [],
        otherReads: "allow",
      }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: {
        type: "validation_error",
        message: expect.stringContaining("closed"),
      },
    });
  });

  it("DELETE detaches with 204", async () => {
    const res = await app.request("/v1/agents/a1/grants/connections/c1", {
      method: "DELETE",
      headers: AUTH,
    });
    expect(res.status).toBe(204);
    expect(services.removeConnectionGrant).toHaveBeenCalledWith(
      SCOPE,
      "a1",
      "c1",
      "user-1",
    );
  });
});

describe("secret grant routes", () => {
  // The twin routes the web's attach-on-create drives (lib/api/grants.ts
  // PUTs `{}` — the route reads no body, only the params and the auth scope).

  it("PUT requires auth", async () => {
    const res = await app.request("/v1/agents/a1/grants/secrets/s1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    expect(services.setSecretGrant).not.toHaveBeenCalled();
  });

  it("PUT attaches with the workspace-fenced scope and returns the updated grants", async () => {
    const res = await app.request("/v1/agents/a1/grants/secrets/s1", {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(GRANTS);
    expect(services.setSecretGrant).toHaveBeenCalledWith(
      SCOPE,
      "a1",
      "s1",
      "user-1",
    );
  });

  it("DELETE detaches with 204 through the same workspace-fenced scope", async () => {
    const res = await app.request("/v1/agents/a1/grants/secrets/s1", {
      method: "DELETE",
      headers: AUTH,
    });
    expect(res.status).toBe(204);
    expect(services.removeSecretGrant).toHaveBeenCalledWith(
      SCOPE,
      "a1",
      "s1",
      "user-1",
    );
  });
});

describe("connection grants routes", () => {
  it("GET returns the per-agent reverse view", async () => {
    const res = await app.request("/v1/connections/c1/grants", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(services.getConnectionGrants).toHaveBeenCalledWith(SCOPE, "c1");
  });

  it("PUT twins onto the same service", async () => {
    const res = await app.request("/v1/connections/c1/grants/agents/a1", {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ access: "full" }),
    });
    expect(res.status).toBe(200);
    expect(services.setConnectionGrant).toHaveBeenCalledWith(
      SCOPE,
      "a1",
      "c1",
      { access: "full" },
      "user-1",
    );
  });
});

describe("GET /v1/agents include projection", () => {
  it("plain GET keeps today's exact behavior", async () => {
    const res = await app.request("/v1/agents", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(services.listAgents).toHaveBeenCalledWith("p1");
    expect(services.listAgentsWithGrantsSummary).not.toHaveBeenCalled();
  });

  it("include=grants-summary routes to the summary service", async () => {
    const res = await app.request("/v1/agents?include=grants-summary", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(services.listAgentsWithGrantsSummary).toHaveBeenCalledWith(
      "p1",
      "org-1",
    );
  });

  it("an unknown include is 422", async () => {
    const res = await app.request("/v1/agents?include=everything", {
      headers: AUTH,
    });
    expect(res.status).toBe(422);
  });
});

describe("connection grant writes, from either side", () => {
  // The agent side (/v1/agents/:agentId/grants/connections/:connectionId) and
  // the connection side (/v1/connections/:connectionId/grants/agents/:agentId)
  // are the same write: the same service call, the same response, the same
  // audit row. Each case runs against both paths.
  const SIDES = [
    ["agent side", "/v1/agents/a1/grants/connections/c1"],
    ["connection side", "/v1/connections/c1/grants/agents/a1"],
  ] as const;

  const auditRow = (action: string, metadata: Record<string, unknown>) => ({
    data: {
      workspaceId: "p1",
      userId: "user-1",
      userEmail: "admin@example.com",
      service: "grant",
      source: "api",
      action,
      status: "success",
      metadata,
    },
  });

  const put = (path: string, body: unknown, headers = AUTH) =>
    app.request(path, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  describe.each(SIDES)("%s", (_side, path) => {
    it("PUT without auth is 401 and writes nothing", async () => {
      const res = await app.request(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ access: "full" }),
      });
      expect(res.status).toBe(401);
      expect(services.setConnectionGrant).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
    });

    it("PUT for a workspace outside the caller's org is refused and writes nothing", async () => {
      const res = await put(
        path,
        { access: "full" },
        { ...AUTH, "x-workspace-id": "other-org-ws" },
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(services.setConnectionGrant).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
    });

    it("PUT with an invalid body is 422 and writes nothing", async () => {
      const res = await put(path, { access: "custom", allow: [], ask: [] });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({
        error: {
          type: "validation_error",
          message: expect.stringContaining("detach instead"),
        },
      });
      expect(services.setConnectionGrant).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
    });

    it("PUT with a body that is not JSON is 422 and writes nothing", async () => {
      const res = await app.request(path, {
        method: "PUT",
        headers: { ...AUTH, "content-type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(422);
      expect(services.setConnectionGrant).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
    });

    it("PUT returns the grants and audits the write, resources preserved", async () => {
      const res = await put(path, { access: "full" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(GRANTS);
      expect(services.setConnectionGrant).toHaveBeenCalledWith(
        SCOPE,
        "a1",
        "c1",
        { access: "full" },
        "user-1",
      );
      expect(auditCreate.mock.calls).toEqual([
        [
          auditRow("update", {
            agentId: "a1",
            connectionId: "c1",
            access: "full",
            resources: "preserved",
            changed: true,
            ruleIds: ["r1"],
          }),
        ],
      ]);
    });

    it("PUT audits a cleared resources restriction", async () => {
      services.setConnectionGrant.mockResolvedValueOnce({
        grants: GRANTS,
        changed: false,
        ruleIds: [],
        generation: 4,
      });
      const res = await put(path, { access: "default", resources: null });
      expect(res.status).toBe(200);
      expect(services.setConnectionGrant).toHaveBeenCalledWith(
        SCOPE,
        "a1",
        "c1",
        { access: "default", resources: null },
        "user-1",
      );
      expect(auditCreate.mock.calls).toEqual([
        [
          auditRow("update", {
            agentId: "a1",
            connectionId: "c1",
            access: "default",
            resources: "cleared",
            changed: false,
            ruleIds: [],
          }),
        ],
      ]);
    });

    it("PUT audits a set resources restriction, never its values", async () => {
      const custom = {
        access: "custom",
        allow: ["t"],
        ask: [],
        resources: { repositories: ["acme/secret-repo"] },
      };
      const res = await put(path, custom);
      expect(res.status).toBe(200);
      expect(services.setConnectionGrant).toHaveBeenCalledWith(
        SCOPE,
        "a1",
        "c1",
        custom,
        "user-1",
      );
      expect(auditCreate.mock.calls).toEqual([
        [
          auditRow("update", {
            agentId: "a1",
            connectionId: "c1",
            access: "custom",
            resources: "set",
            changed: true,
            ruleIds: ["r1"],
          }),
        ],
      ]);
    });

    it("PUT maps a service refusal to its status and writes no audit row", async () => {
      const { ServiceError } = await import("../services/errors");
      services.setConnectionGrant.mockRejectedValueOnce(
        new ServiceError("NOT_FOUND", "Connection not found"),
      );
      const res = await put(path, { access: "full" });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({
        error: { message: "Connection not found" },
      });
      expect(auditCreate).not.toHaveBeenCalled();
    });

    it("DELETE detaches with an empty 204 and audits the removal", async () => {
      services.removeConnectionGrant.mockResolvedValueOnce({
        grants: GRANTS,
        changed: false,
        ruleIds: ["ignored"],
        generation: 3,
      });
      const res = await app.request(path, { method: "DELETE", headers: AUTH });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      expect(services.removeConnectionGrant).toHaveBeenCalledWith(
        SCOPE,
        "a1",
        "c1",
        "user-1",
      );
      expect(auditCreate.mock.calls).toEqual([
        [
          auditRow("delete", {
            agentId: "a1",
            connectionId: "c1",
            changed: false,
          }),
        ],
      ]);
    });

    it("DELETE without auth is 401 and writes nothing", async () => {
      const res = await app.request(path, { method: "DELETE" });
      expect(res.status).toBe(401);
      expect(services.removeConnectionGrant).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
    });

    it("DELETE maps a service refusal to its status and writes no audit row", async () => {
      const { ServiceError } = await import("../services/errors");
      services.removeConnectionGrant.mockRejectedValueOnce(
        new ServiceError("NOT_FOUND", "Agent not found"),
      );
      const res = await app.request(path, { method: "DELETE", headers: AUTH });
      expect(res.status).toBe(404);
      expect(auditCreate).not.toHaveBeenCalled();
    });
  });
});
