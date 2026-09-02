import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The skills workspace door's HTTP contract (step 9). The DB laws — tiers,
 * shadowing, caps, cascades — live in skills.pg.test.ts; services are mocked
 * here so this file is about status codes, validation, creator threading,
 * the org-row FORBIDDEN pass-through, and the token-family fence.
 */

const ORG_KEY = "oc_org_test-key";
const RUNNER_TOKEN = "rnr_a-runner";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

const services = vi.hoisted(() => ({
  listSkillsForWorkspace: vi.fn(),
  getSkill: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
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

vi.mock("../services/skill-service", () => ({
  listSkillsForWorkspace: services.listSkillsForWorkspace,
  getSkill: services.getSkill,
  createSkill: services.createSkill,
  updateSkill: services.updateSkill,
  deleteSkill: services.deleteSkill,
  // Real co-importers of the mocked module still need these named exports.
  listOrgSkills: vi.fn(),
  getOrgSkill: vi.fn(),
  createOrgSkill: vi.fn(),
  updateOrgSkill: vi.fn(),
  deleteOrgSkill: vi.fn(),
}));

const { createApiApp } = await import("../app");
const { ServiceError } = await import("../services/errors");

const app = createApiApp({ getSession: async () => null });

const AUTH = {
  authorization: `Bearer ${ORG_KEY}`,
  "x-workspace-id": "p1",
  "content-type": "application/json",
};

const SKILL = {
  id: "sk-1",
  scope: "workspace",
  agentId: null,
  workspaceId: "p1",
  organizationId: null,
  name: "release-checklist",
  description: "How we ship",
  content: "# Steps",
  enabled: true,
  createdByEmail: "admin@example.com",
  createdAt: new Date("2026-08-08T00:00:00Z"),
  updatedAt: new Date("2026-08-08T00:00:00Z"),
  files: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  services.listSkillsForWorkspace.mockResolvedValue([
    { ...SKILL, fileCount: 0 },
  ]);
  services.getSkill.mockResolvedValue(SKILL);
  services.createSkill.mockResolvedValue(SKILL);
  services.updateSkill.mockResolvedValue(SKILL);
  services.deleteSkill.mockResolvedValue(undefined);
});

describe("the workspace door", () => {
  it("lists every tier reaching the workspace", async () => {
    const response = await app.request("/v1/skills", { headers: AUTH });
    expect(response.status).toBe(200);
    expect(services.listSkillsForWorkspace).toHaveBeenCalledWith("p1", "org-1");
  });

  it("create threads the creator and 201s; agentId selects the agent tier", async () => {
    const response = await app.request("/v1/skills", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        name: "release-checklist",
        description: "How we ship",
        content: "# Steps",
        agentId: "ag-1",
      }),
    });
    expect(response.status).toBe(201);
    expect(services.createSkill).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ name: "release-checklist", agentId: "ag-1" }),
      { userId: "user-1", email: "admin@example.com" },
    );
  });

  it("refuses the reserved gateway name, a bad kebab, and an over-budget body", async () => {
    for (const body of [
      { name: "onecli-gateway", description: "d", content: "x" },
      { name: "Bad Name", description: "d", content: "x" },
      {
        name: "big",
        description: "d",
        content: "x".repeat(24_000),
        files: [{ path: "extra.md", content: "y".repeat(10_000) }],
      },
    ]) {
      const response = await app.request("/v1/skills", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify(body),
      });
      expect(response.status, JSON.stringify(body).slice(0, 60)).toBe(422);
    }
    expect(services.createSkill).not.toHaveBeenCalled();
  });

  it("refuses a name rename (immutable) and an empty patch", async () => {
    for (const payload of [{}, { name: "new-name" }]) {
      const response = await app.request("/v1/skills/sk-1", {
        method: "PATCH",
        headers: AUTH,
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(422);
    }
    expect(services.updateSkill).not.toHaveBeenCalled();
  });

  it("an org-tier row's write refusal passes through as 403 with the pointer", async () => {
    services.updateSkill.mockRejectedValue(
      new ServiceError(
        "FORBIDDEN",
        "Organization skills are managed in organization settings",
      ),
    );
    const response = await app.request("/v1/skills/sk-org", {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({ content: "changed" }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("organization settings");
  });

  it("deletes with 204; a runner token never drives this surface", async () => {
    const ok = await app.request("/v1/skills/sk-1", {
      method: "DELETE",
      headers: AUTH,
    });
    expect(ok.status).toBe(204);

    const fenced = await app.request("/v1/skills", {
      headers: {
        authorization: `Bearer ${RUNNER_TOKEN}`,
        "x-workspace-id": "p1",
      },
    });
    expect(fenced.status).toBe(401);
  });
});
