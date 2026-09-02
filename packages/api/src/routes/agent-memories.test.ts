import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The memory HTTP contract (step 8). The DB laws — revisions, fences, the
 * search — live in services/memory.pg.test.ts; services are mocked here so
 * this file is about status codes, validation, the author threading on
 * writes, and the token-family fence (a runner token must never drive the
 * dashboard surface — the relay's own mirror-image fence is pinned in
 * agent-crons.test.ts, one door for all tools).
 */

const ORG_KEY = "oc_org_test-key";
const RUNNER_TOKEN = "rnr_a-runner";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

const services = vi.hoisted(() => ({
  listMemories: vi.fn(),
  searchMemoriesForWorkspace: vi.fn(),
  getMemory: vi.fn(),
  createMemory: vi.fn(),
  updateMemory: vi.fn(),
  deleteMemory: vi.fn(),
  listRevisions: vi.fn(),
  restoreRevision: vi.fn(),
  redactRevision: vi.fn(),
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

vi.mock("../services/agent-memory-service", () => ({
  listMemories: services.listMemories,
  searchMemoriesForWorkspace: services.searchMemoriesForWorkspace,
  getMemory: services.getMemory,
  createMemory: services.createMemory,
  updateMemory: services.updateMemory,
  deleteMemory: services.deleteMemory,
  listRevisions: services.listRevisions,
  restoreRevision: services.restoreRevision,
  redactRevision: services.redactRevision,
  // Real co-importers of the mocked module (platform-tool-service, the
  // turn-context builder) still need these named exports to exist.
  upsertMemoryByKey: vi.fn(),
  getMemoryByKey: vi.fn(),
  searchMemories: vi.fn(),
  memoryPressure: vi.fn(),
  MAX_MEMORIES_PER_AGENT: 100,
  MEMORY_REVISIONS_RETAINED: 50,
  MEMORY_SEARCH_LIMIT: 8,
  REDACTED_CONTENT: "[redacted]",
}));

const { createApiApp } = await import("../app");
const { ServiceError } = await import("../services/errors");

const app = createApiApp({ getSession: async () => null });

const AUTH = {
  authorization: `Bearer ${ORG_KEY}`,
  "x-workspace-id": "p1",
  "content-type": "application/json",
};

/** The dashboard door's provenance, asserted on every write. */
const USER_AUTHOR = {
  authorKind: "user",
  authorUserId: "user-1",
  authorEmail: "admin@example.com",
  conversationId: null,
  turnId: null,
};

const MEMORY = {
  id: "mem-1",
  agentId: "ag-1",
  key: "deploy-notes",
  title: null,
  description: "How deploys work",
  content: "Deploys run from CI.",
  lastRevisionSeq: 1,
  createdAt: new Date("2026-08-07T00:00:00Z"),
  updatedAt: new Date("2026-08-07T00:00:00Z"),
};

const REVISION = {
  id: "rev-1",
  seq: 1,
  op: "save",
  restoredFromSeq: null,
  title: null,
  description: "How deploys work",
  content: "Deploys run from CI.",
  authorKind: "user",
  authorUserId: "user-1",
  authorEmail: "admin@example.com",
  conversationId: null,
  turnId: null,
  redactedAt: null,
  redactedByUserId: null,
  createdAt: new Date("2026-08-07T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  services.listMemories.mockResolvedValue([MEMORY]);
  services.searchMemoriesForWorkspace.mockResolvedValue([]);
  services.getMemory.mockResolvedValue({ ...MEMORY, latestRevision: REVISION });
  services.createMemory.mockResolvedValue(MEMORY);
  services.updateMemory.mockResolvedValue(MEMORY);
  services.deleteMemory.mockResolvedValue(undefined);
  services.listRevisions.mockResolvedValue([REVISION]);
  services.restoreRevision.mockResolvedValue(MEMORY);
  services.redactRevision.mockResolvedValue(REVISION);
});

describe("the index and search door", () => {
  it("lists the agent's memories", async () => {
    const response = await app.request("/v1/agents/ag-1/memories", {
      headers: AUTH,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { memories: unknown[] };
    expect(body.memories).toHaveLength(1);
    expect(services.listMemories).toHaveBeenCalledWith("p1", "ag-1");
  });

  it("?q= flips the same endpoint into ranked search", async () => {
    const response = await app.request("/v1/agents/ag-1/memories?q=deploy", {
      headers: AUTH,
    });
    expect(response.status).toBe(200);
    expect(services.searchMemoriesForWorkspace).toHaveBeenCalledWith(
      "p1",
      "ag-1",
      "deploy",
    );
    expect(services.listMemories).not.toHaveBeenCalled();
  });

  it("rejects an oversized query", async () => {
    const q = "x".repeat(501);
    const response = await app.request(`/v1/agents/ag-1/memories?q=${q}`, {
      headers: AUTH,
    });
    expect(response.status).toBe(422);
  });
});

describe("the write doors", () => {
  it("create stamps the dashboard author and 201s", async () => {
    const response = await app.request("/v1/agents/ag-1/memories", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        key: "deploy-notes",
        content: "Deploys run from CI.",
        description: "How deploys work",
      }),
    });
    expect(response.status).toBe(201);
    expect(services.createMemory).toHaveBeenCalledWith(
      "p1",
      "ag-1",
      expect.objectContaining({ key: "deploy-notes" }),
      USER_AUTHOR,
    );
  });

  it("refuses a malformed key before the service sees it", async () => {
    const response = await app.request("/v1/agents/ag-1/memories", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ key: "Deploy Notes", content: "x" }),
    });
    expect(response.status).toBe(422);
    expect(services.createMemory).not.toHaveBeenCalled();
  });

  it("refuses oversized content with the instructive message", async () => {
    // The dashboard door takes the FILE cap (100k) since the write-back
    // amendment; the 12k cap is the tool door's alone.
    const response = await app.request("/v1/agents/ag-1/memories", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ key: "big", content: "x".repeat(100_001) }),
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("100,000");
  });

  it("accepts content between the tool cap and the file cap", async () => {
    const response = await app.request("/v1/agents/ag-1/memories", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ key: "mid", content: "x".repeat(40_000) }),
    });
    expect(response.status).toBe(201);
  });

  it("refuses an empty patch, an unknown body key, and a key rename", async () => {
    for (const payload of [{}, { nextFireAt: "x" }, { key: "new-name" }]) {
      const response = await app.request("/v1/agents/ag-1/memories/mem-1", {
        method: "PATCH",
        headers: AUTH,
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(422);
    }
    expect(services.updateMemory).not.toHaveBeenCalled();
  });

  it("patch threads the author through", async () => {
    const response = await app.request("/v1/agents/ag-1/memories/mem-1", {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({ content: "Deploys run from CD now." }),
    });
    expect(response.status).toBe(200);
    expect(services.updateMemory).toHaveBeenCalledWith(
      "p1",
      "ag-1",
      "mem-1",
      { content: "Deploys run from CD now." },
      USER_AUTHOR,
    );
  });

  it("deletes with 204", async () => {
    const response = await app.request("/v1/agents/ag-1/memories/mem-1", {
      method: "DELETE",
      headers: AUTH,
    });
    expect(response.status).toBe(204);
    expect(services.deleteMemory).toHaveBeenCalledWith("p1", "ag-1", "mem-1");
  });

  it("passes a service NOT_FOUND through as 404", async () => {
    services.getMemory.mockRejectedValue(
      new ServiceError("NOT_FOUND", "Memory not found"),
    );
    const response = await app.request("/v1/agents/ag-1/memories/mem-x", {
      headers: AUTH,
    });
    expect(response.status).toBe(404);
  });
});

describe("the history doors", () => {
  it("lists revisions", async () => {
    const response = await app.request(
      "/v1/agents/ag-1/memories/mem-1/revisions",
      { headers: AUTH },
    );
    expect(response.status).toBe(200);
    expect(services.listRevisions).toHaveBeenCalledWith("p1", "ag-1", "mem-1");
  });

  it("restore threads the author; redact carries the redactor", async () => {
    const restore = await app.request(
      "/v1/agents/ag-1/memories/mem-1/revisions/rev-1/restore",
      { method: "POST", headers: AUTH, body: "{}" },
    );
    expect(restore.status).toBe(200);
    expect(services.restoreRevision).toHaveBeenCalledWith(
      "p1",
      "ag-1",
      "mem-1",
      "rev-1",
      USER_AUTHOR,
    );

    const redact = await app.request(
      "/v1/agents/ag-1/memories/mem-1/revisions/rev-1/redact",
      { method: "POST", headers: AUTH, body: "{}" },
    );
    expect(redact.status).toBe(200);
    expect(services.redactRevision).toHaveBeenCalledWith(
      "p1",
      "ag-1",
      "mem-1",
      "rev-1",
      "user-1",
    );
  });

  it("a refused redact surfaces the service's exact words", async () => {
    services.redactRevision.mockRejectedValue(
      new ServiceError(
        "UNPROCESSABLE",
        "This is the current version: edit or delete the memory first, then redact the old revision",
      ),
    );
    const response = await app.request(
      "/v1/agents/ag-1/memories/mem-1/revisions/rev-9/redact",
      { method: "POST", headers: AUTH, body: "{}" },
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("edit or delete the memory first");
  });
});

describe("the token-family fence", () => {
  it("a runner token never drives the dashboard surface", async () => {
    const response = await app.request("/v1/agents/ag-1/memories", {
      headers: {
        authorization: `Bearer ${RUNNER_TOKEN}`,
        "x-workspace-id": "p1",
      },
    });
    expect(response.status).toBe(401);
    expect(services.listMemories).not.toHaveBeenCalled();
  });
});
