import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The skills ORG door's HTTP contract (step 9) — the free /v1/org/skills
 * surface: member reads, validation, org-scoped audit threading, the
 * token-family fence, and BOTH arms of the `CAPS.rbac` write gate. The two
 * arms need two apps because the guard is baked at router construction
 * (the channel-routes precedent).
 */

const ORG_KEY = "oc_org_test-key";
const RUNNER_TOKEN = "rnr_a-runner";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

const caps = vi.hoisted(() => ({ rbac: false }));
const store = vi.hoisted(() => ({
  role: "owner" as "owner" | "admin" | "member",
}));

vi.mock("../lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/env")>();
  return {
    ...actual,
    CAPS: {
      ...actual.CAPS,
      get rbac() {
        return caps.rbac;
      },
    },
  };
});

const services = vi.hoisted(() => ({
  listOrgSkills: vi.fn(),
  getOrgSkill: vi.fn(),
  createOrgSkill: vi.fn(),
  updateOrgSkill: vi.fn(),
  deleteOrgSkill: vi.fn(),
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
    user: {
      findUnique: async () => ({ id: "user-1", email: "admin@example.com" }),
    },
    organizationMember: {
      findUnique: async () => ({
        organizationId: "org-1",
        userId: "user-1",
        role: "owner",
      }),
      // The session path's x-organization-id membership fence (resolve.ts).
      findFirst: async () => ({ organizationId: "org-1" }),
    },
    workspace: { findFirst: async () => null },
    auditLog: { create: async () => ({}) },
  },
}));

vi.mock("../services/skill-service", () => ({
  listOrgSkills: services.listOrgSkills,
  getOrgSkill: services.getOrgSkill,
  createOrgSkill: services.createOrgSkill,
  updateOrgSkill: services.updateOrgSkill,
  deleteOrgSkill: services.deleteOrgSkill,
  listSkillsForWorkspace: vi.fn(),
  getSkill: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
}));

const { createApiApp } = await import("../app");

const app = createApiApp({ getSession: async () => null });

// The cloud arm: roles exist and the write gate consults them.
caps.rbac = true;
const appRbacOn = createApiApp(
  { getSession: async () => null },
  { roleResolver: { getUserRole: async () => store.role } },
);
// The same arm authenticated by SESSION: under RBAC a member-held ORG KEY
// dies at the key's own admin re-check (401, before any route), so the role
// gate on the routes is only observable through a session caller.
const appRbacOnSession = createApiApp(
  { getSession: async () => ({ id: "sub-1", email: "member@example.com" }) },
  { roleResolver: { getUserRole: async () => store.role } },
);
caps.rbac = false;

const AUTH = {
  authorization: `Bearer ${ORG_KEY}`,
  "content-type": "application/json",
};

const SKILL = {
  id: "sk-org",
  scope: "organization",
  agentId: null,
  workspaceId: null,
  organizationId: "org-1",
  name: "org-standards",
  description: "House rules",
  content: "# Rules",
  enabled: true,
  createdByEmail: "admin@example.com",
  createdAt: new Date("2026-08-08T00:00:00Z"),
  updatedAt: new Date("2026-08-08T00:00:00Z"),
  files: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  services.listOrgSkills.mockResolvedValue([{ ...SKILL, fileCount: 0 }]);
  services.getOrgSkill.mockResolvedValue(SKILL);
  services.createOrgSkill.mockResolvedValue(SKILL);
  services.updateOrgSkill.mockResolvedValue(SKILL);
  services.deleteOrgSkill.mockResolvedValue(undefined);
});

describe("the org door", () => {
  it("lists the org's rows without a workspace header", async () => {
    const response = await app.request("/v1/org/skills", { headers: AUTH });
    expect(response.status).toBe(200);
    expect(services.listOrgSkills).toHaveBeenCalledWith("org-1");
  });

  it("create threads the org creator and never accepts an agentId", async () => {
    const created = await app.request("/v1/org/skills", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        name: "org-standards",
        description: "House rules",
        content: "# Rules",
      }),
    });
    expect(created.status).toBe(201);
    expect(services.createOrgSkill).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ name: "org-standards" }),
      { userId: "user-1", email: "admin@example.com" },
    );

    const withAgent = await app.request("/v1/org/skills", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        name: "x",
        description: "d",
        content: "c",
        agentId: "ag-1",
      }),
    });
    // .strict() — the org schema has no agentId at all.
    expect(withAgent.status).toBe(422);
  });

  it("patch + delete round-trip; a runner token never drives the surface", async () => {
    const patched = await app.request("/v1/org/skills/sk-org", {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({ enabled: false }),
    });
    expect(patched.status).toBe(200);
    expect(services.updateOrgSkill).toHaveBeenCalledWith("org-1", "sk-org", {
      enabled: false,
    });

    const deleted = await app.request("/v1/org/skills/sk-org", {
      method: "DELETE",
      headers: AUTH,
    });
    expect(deleted.status).toBe(204);

    const fenced = await app.request("/v1/org/skills", {
      headers: { authorization: `Bearer ${RUNNER_TOKEN}` },
    });
    expect(fenced.status).toBe(401);
  });
});

describe("the write gate where roles are ENFORCED (CAPS.rbac on)", () => {
  // Production rbac is boot-stable: a deployment that builds the admin arm of
  // the route ternary also has rbac on when requests arrive (the auth
  // middleware's role gate reads it at request time too — the flat-team arm).
  beforeEach(() => {
    caps.rbac = true;
  });
  afterEach(() => {
    caps.rbac = false;
  });

  const SESSION_AUTH = {
    "x-organization-id": "org-1",
    "content-type": "application/json",
  };

  it("REFUSES a plain member with 403, before the service is reached", async () => {
    // MUTATION-TESTED (one half of the guard ternary): collapse
    // `CAPS.rbac ? auth({role:"admin"}) : auth()` to the permissive arm and
    // any cloud member can write org-tier skills — which the projection
    // pushes into every hosted agent's sandbox in every workspace of the org.
    store.role = "member";

    const created = await appRbacOnSession.request("/v1/org/skills", {
      method: "POST",
      headers: SESSION_AUTH,
      body: JSON.stringify({
        name: "member-rules",
        description: "d",
        content: "c",
      }),
    });
    expect(created.status).toBe(403);
    expect(services.createOrgSkill).not.toHaveBeenCalled();

    const patched = await appRbacOnSession.request("/v1/org/skills/sk-org", {
      method: "PATCH",
      headers: SESSION_AUTH,
      body: JSON.stringify({ content: "x" }),
    });
    expect(patched.status).toBe(403);
    expect(services.updateOrgSkill).not.toHaveBeenCalled();

    const deleted = await appRbacOnSession.request("/v1/org/skills/sk-org", {
      method: "DELETE",
      headers: SESSION_AUTH,
    });
    expect(deleted.status).toBe(403);
    expect(services.deleteOrgSkill).not.toHaveBeenCalled();
  });

  it("still lets that member READ — the rows reach their workspaces anyway", async () => {
    store.role = "member";
    const response = await appRbacOnSession.request("/v1/org/skills", {
      headers: SESSION_AUTH,
    });
    expect(response.status).toBe(200);
  });

  it("a member-held ORG KEY dies at authentication under RBAC", async () => {
    // The org-key admin re-check refuses the key itself — a demotion revokes
    // the key's power everywhere, before any route or role gate.
    store.role = "member";
    const response = await appRbacOn.request("/v1/org/skills", {
      headers: AUTH,
    });
    expect(response.status).toBe(401);
  });

  it("lets an admin write", async () => {
    store.role = "admin";
    const created = await appRbacOn.request("/v1/org/skills", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        name: "admin-rules",
        description: "d",
        content: "c",
      }),
    });
    expect(created.status).toBe(201);
    expect(services.createOrgSkill).toHaveBeenCalled();
  });
});
