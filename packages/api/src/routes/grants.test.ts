import { beforeEach, describe, expect, it, vi } from "vitest";

// The grants routes' HTTP contract: auth, param/body validation, status codes,
// and the service-call wiring (services are mocked — their laws live in
// grants-service.test.ts and grants-service.pg.test.ts).

const ORG_KEY = "oc_org_test-key";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem-slim";
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

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === ORG_KEY
          ? { userId: "user-1", organizationId: "org-1", scope: "organization" }
          : null,
      // withAudit's server-side gateway flush borrows a project key; none here
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
    project: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        where.id === "p1" ? { id: "p1" } : null,
    },
    auditLog: { create: async () => ({}) },
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
  getDefaultAgent: vi.fn(),
  setDefaultAgent: vi.fn(),
  renameAgent: vi.fn(),
  deleteAgent: vi.fn(),
  regenerateAgentToken: vi.fn(),
}));

const { createApiApp } = await import("../app");

const app = createApiApp({ getSession: async () => null });

const AUTH = {
  authorization: `Bearer ${ORG_KEY}`,
  "x-project-id": "p1",
};
const SCOPE = { projectId: "p1", organizationId: "org-1" };
const GRANTS = {
  agentId: "a1",
  mode: "grants",
  connections: [],
  secrets: [],
};

beforeEach(() => {
  for (const fn of Object.values(services)) fn.mockReset();
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
  services.listAgentsWithGrantsSummary.mockResolvedValue([]);
  services.listAgents.mockResolvedValue([]);
});

describe("agent grants routes", () => {
  it("requires auth", async () => {
    const res = await app.request("/v1/agents/a1/grants");
    expect(res.status).toBe(401);
  });

  it("GET returns the agent's grants with the project scope", async () => {
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
