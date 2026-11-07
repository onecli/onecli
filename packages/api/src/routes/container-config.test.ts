import { beforeEach, describe, expect, it, vi } from "vitest";

// The container-config route's HTTP contract for the one outcome it maps to
// a refusal of its own: a hosted agent. Which agent resolves (and that a
// hosted one never does) is proven on real PostgreSQL in
// container-config-agent.pg.test.ts; this pins the status, the code, and
// that the config builder is never even reached.

const ORG_KEY = "oc_org_test-key";

vi.hoisted(() => {
  // Pinned onprem: CAPS.rbac off, so the org-key auth needs no role resolver.
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

const services = vi.hoisted(() => ({
  resolveContainerConfigAgent: vi.fn(),
  buildContainerConfig: vi.fn(),
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
  },
}));

vi.mock("../services/container-config-service", () => ({
  resolveContainerConfigAgent: services.resolveContainerConfigAgent,
  buildContainerConfig: services.buildContainerConfig,
  injectableSecretWhere: vi.fn(),
  findInjectableSecretOfType: vi.fn(),
}));

const { createApiApp } = await import("../app");
const app = createApiApp({ getSession: async () => null });

const AUTH = { authorization: `Bearer ${ORG_KEY}`, "x-workspace-id": "p1" };

beforeEach(() => {
  for (const fn of Object.values(services)) fn.mockReset();
});

describe("GET /v1/container-config: hosted agents", () => {
  it("refuses a hosted agent with 403 HOSTED_AGENT and never builds its config", async () => {
    services.resolveContainerConfigAgent.mockResolvedValue({
      outcome: "hosted-agent",
    });
    const res = await app.request("/v1/container-config?agent=donna", {
      headers: AUTH,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("HOSTED_AGENT");
    expect(body.error).toContain("never handed out");
    expect(JSON.stringify(body)).not.toContain("aoc_");
    expect(services.buildContainerConfig).not.toHaveBeenCalled();
  });

  it("still serves a BYO agent's config (the customer's runtime needs it)", async () => {
    services.resolveContainerConfigAgent.mockResolvedValue({
      outcome: "resolved",
      agent: { id: "a1", accessToken: "aoc_byo" },
    });
    services.buildContainerConfig.mockResolvedValue({
      ok: true,
      config: { env: { HTTPS_PROXY: "http://x:aoc_byo@gateway:10255" } },
    });
    const res = await app.request("/v1/container-config?agent=laptop", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(services.buildContainerConfig).toHaveBeenCalledWith(
      expect.objectContaining({ agent: { id: "a1", accessToken: "aoc_byo" } }),
    );
  });
});
