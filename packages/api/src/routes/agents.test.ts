import { beforeEach, describe, expect, it, vi } from "vitest";

// The agents routes' HTTP contract for hosted-agents step 1: body validation
// (kind + the hosted-only fields), the service-call wiring, and the quota-hook
// ordering. Services are mocked — their laws live in agent-service.test.ts and
// agent-service.pg.test.ts.

const ORG_KEY = "oc_org_test-key";

vi.hoisted(() => {
  // Pinned onprem: CAPS.rbac off, so the org-key auth needs no role resolver —
  // the suite tests the routes' HTTP contract, not role enforcement.
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

const auditCreate = vi.hoisted(() => vi.fn(async () => ({})));

const services = vi.hoisted(() => ({
  listAgents: vi.fn(),
  createAgent: vi.fn(),
  agentExistsByIdentifier: vi.fn(),
  getAgentDetail: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  regenerateAgentToken: vi.fn(),
  listAgentsWithGrantsSummary: vi.fn(),
  setAgentImage: vi.fn(),
  clearAgentImage: vi.fn(),
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

vi.mock("../services/agent-service", () => ({
  listAgents: services.listAgents,
  createAgent: services.createAgent,
  agentExistsByIdentifier: services.agentExistsByIdentifier,
  getAgentDetail: services.getAgentDetail,
  updateAgent: services.updateAgent,
  deleteAgent: services.deleteAgent,
  regenerateAgentToken: services.regenerateAgentToken,
}));

vi.mock("../services/grants-summary-service", () => ({
  listAgentsWithGrantsSummary: services.listAgentsWithGrantsSummary,
}));

vi.mock("../services/agent-image-service", () => ({
  setAgentImage: services.setAgentImage,
  clearAgentImage: services.clearAgentImage,
  // The route reads the cap for its mid-stream gate — a real number, so the
  // 413 arm below can actually cross it.
  MAX_AGENT_IMAGE_BYTES: 1024 * 1024,
}));

const { createApiApp } = await import("../app");
const { ServiceError } = await import("../services/errors");

const app = createApiApp({ getSession: async () => null });

const AUTH = {
  authorization: `Bearer ${ORG_KEY}`,
  "x-workspace-id": "p1",
  "content-type": "application/json",
};

const CREATED = {
  id: "a-new",
  name: "Name",
  identifier: "name",
  kind: "byo",
  harness: null,
  model: null,
  instructions: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  for (const fn of Object.values(services)) fn.mockReset();
  services.agentExistsByIdentifier.mockResolvedValue(false);
  services.createAgent.mockResolvedValue(CREATED);
  services.updateAgent.mockResolvedValue(undefined);
  services.listAgents.mockResolvedValue([]);
});

describe("POST /v1/agents", () => {
  it("requires auth", async () => {
    const res = await app.request("/v1/agents", {
      method: "POST",
      body: JSON.stringify({ name: "N", identifier: "n" }),
    });
    expect(res.status).toBe(401);
  });

  it("creates a byo agent by default (the BYO regression at the HTTP layer)", async () => {
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ name: "Name", identifier: "name" }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(CREATED);
    expect(services.createAgent).toHaveBeenCalledWith(
      "p1",
      {
        name: "Name",
        identifier: "name",
        kind: "byo",
        harness: undefined,
        model: undefined,
        instructions: undefined,
      },
      // The grantor threaded through for the service's LLM auto-attach.
      "user-1",
    );
  });

  it("threads the hosted fields through to the service", async () => {
    await app.request("/v1/agents", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        name: "Support",
        identifier: "support",
        kind: "hosted",
        instructions: "Triage the inbox.",
      }),
    });
    expect(services.createAgent).toHaveBeenCalledWith(
      "p1",
      {
        name: "Support",
        identifier: "support",
        kind: "hosted",
        harness: undefined,
        instructions: "Triage the inbox.",
      },
      "user-1",
    );
  });

  it("400s an unknown kind without touching the service", async () => {
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ name: "N", identifier: "n", kind: "vm" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.any(String) });
    expect(services.createAgent).not.toHaveBeenCalled();
  });

  it("400s an unknown harness without touching the service", async () => {
    // The column is a free string (the adapter-#2 seam), but the API refuses
    // ids no composition root can boot — a typo would silently run the
    // default adapter otherwise.
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        name: "N",
        identifier: "n",
        kind: "hosted",
        harness: "jcodee",
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.any(String) });
    expect(services.createAgent).not.toHaveBeenCalled();
  });

  it('keeps "fake" creatable — hosted-e2e drives it through this real API', async () => {
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        name: "Fake",
        identifier: "fake-agent",
        kind: "hosted",
        harness: "fake",
      }),
    });
    expect(res.status).toBe(201);
    expect(services.createAgent).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ harness: "fake" }),
      "user-1",
    );
  });

  it("400s hosted-only fields on a byo create", async () => {
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        name: "N",
        identifier: "n",
        instructions: "nope",
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("hosted");
    expect(services.createAgent).not.toHaveBeenCalled();
  });

  it("surfaces the canonical 409 for an existing identifier (409 wins over 403)", async () => {
    services.agentExistsByIdentifier.mockResolvedValue(true);
    services.createAgent.mockRejectedValue(
      new ServiceError(
        "CONFLICT",
        "An agent with this identifier already exists",
      ),
    );
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ name: "Name", identifier: "taken" }),
    });
    // The route consulted the existence probe before any quota decision; the
    // service's canonical conflict is what surfaces.
    expect(services.agentExistsByIdentifier).toHaveBeenCalledWith(
      "p1",
      "taken",
    );
    expect(res.status).toBe(409);
  });
});

describe("PATCH /v1/agents/:agentId", () => {
  it("renames through updateAgent", async () => {
    const res = await app.request("/v1/agents/a1", {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(services.updateAgent).toHaveBeenCalledWith("p1", "a1", {
      name: "Renamed",
    });
  });

  it("updates and clears the brief", async () => {
    await app.request("/v1/agents/a1", {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({ instructions: "Be terse." }),
    });
    expect(services.updateAgent).toHaveBeenCalledWith("p1", "a1", {
      instructions: "Be terse.",
    });

    await app.request("/v1/agents/a1", {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({ instructions: null }),
    });
    expect(services.updateAgent).toHaveBeenLastCalledWith("p1", "a1", {
      instructions: null,
    });
  });

  it("400s an empty patch without touching the service", async () => {
    const res = await app.request("/v1/agents/a1", {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(services.updateAgent).not.toHaveBeenCalled();
  });
});

describe("PUT/DELETE /v1/agents/:agentId/image", () => {
  // Raw-binary headers, NOT the JSON `AUTH` (its content-type would lie).
  const BIN_AUTH = {
    authorization: `Bearer ${ORG_KEY}`,
    "x-workspace-id": "p1",
    "content-type": "image/png",
  };
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it("requires auth", async () => {
    const res = await app.request("/v1/agents/a1/image", {
      method: "PUT",
      body: PNG,
    });
    expect(res.status).toBe(401);
    expect(services.setAgentImage).not.toHaveBeenCalled();
  });

  it("stores the raw bytes workspace-fenced and answers the public URL", async () => {
    services.setAgentImage.mockResolvedValue({
      imageUrl: "https://api.example.com/v1/agent-images/a1/k",
    });
    const res = await app.request("/v1/agents/a1/image", {
      method: "PUT",
      headers: BIN_AUTH,
      body: PNG,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      imageUrl: "https://api.example.com/v1/agent-images/a1/k",
    });
    const [ws, id, bytes] = services.setAgentImage.mock.calls[0] as [
      string,
      string,
      Buffer,
    ];
    expect([ws, id]).toEqual(["p1", "a1"]);
    expect(Buffer.from(bytes).equals(PNG)).toBe(true);
    // Audited: the avatar is externally visible content and this route is
    // its only door. Ids only — never the bytes or the serving key.
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "update",
          service: "agent",
          source: "api",
          metadata: { agentId: "a1", field: "image" },
        }),
      }),
    );
  });

  it("413s past the cap in the CANONICAL error shape, service untouched", async () => {
    const res = await app.request("/v1/agents/a1/image", {
      method: "PUT",
      headers: BIN_AUTH,
      body: Buffer.alloc(1024 * 1024 + 1, 0x89),
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error.message).toMatch(/capped/);
    expect(body.error.type).toBe("invalid_request_error");
    expect(services.setAgentImage).not.toHaveBeenCalled();
  });

  it("422s an empty body", async () => {
    const res = await app.request("/v1/agents/a1/image", {
      method: "PUT",
      headers: BIN_AUTH,
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toBe("The image is empty.");
    expect(services.setAgentImage).not.toHaveBeenCalled();
  });

  it("DELETE clears workspace-fenced, audited, and answers 204", async () => {
    services.clearAgentImage.mockResolvedValue(undefined);
    const res = await app.request("/v1/agents/a1/image", {
      method: "DELETE",
      headers: AUTH,
    });
    expect(res.status).toBe(204);
    expect(services.clearAgentImage).toHaveBeenCalledWith("p1", "a1");
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "delete",
          service: "agent",
          source: "api",
          metadata: { agentId: "a1", field: "image" },
        }),
      }),
    );
  });
});

describe("GET /v1/agents", () => {
  it("passes the service list through, kind included", async () => {
    const row = {
      id: "a1",
      name: "A",
      identifier: "a",
      accessToken: "aoc_x",
      kind: "hosted",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: null,
    };
    services.listAgents.mockResolvedValue([row]);
    const res = await app.request("/v1/agents", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([row]);
  });
});

describe("the default-agent surface is gone", () => {
  // The concept retired: nothing is seeded, every agent is deletable, and
  // omitting `agent=` at /v1/container-config only resolves a pre-v2
  // workspace's legacy default. These are 410s rather than 404s so a stale
  // client reads why.
  it.each([
    ["GET", "/v1/agents/default", /default-agent concept is retired/i],
    ["POST", "/v1/agents/a1/set-default", /pin a machine to a specific agent/i],
  ])("%s %s answers 410 with the reason", async (method, path, reason) => {
    const res = await app.request(path, { method, headers: AUTH });
    expect(res.status).toBe(410);
    expect((await res.json()).error.message).toMatch(reason);
  });

  it("does not shadow a real agent id — GET /v1/agents/:id still works", async () => {
    // `/default` is a literal path on the same base; the live route must win
    // for every other id.
    services.getAgentDetail.mockResolvedValue({ id: "a1", name: "A" });
    const res = await app.request("/v1/agents/a1", { headers: AUTH });
    expect(res.status).toBe(200);
  });

  it("deletes the last agent — no default guard left", async () => {
    services.deleteAgent.mockResolvedValue(undefined);
    const res = await app.request("/v1/agents/a1", {
      method: "DELETE",
      headers: AUTH,
    });
    expect(res.status).toBe(204);
    expect(services.deleteAgent).toHaveBeenCalledWith("p1", "a1");
  });
});
