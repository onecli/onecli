import { describe, expect, it, vi } from "vitest";

// The identity routes' auth posture: GET /user must work without a project
// header — `onecli auth login` verifies keys through it, and an ORG key
// carries no project of its own (the regression read every org key as
// invalid). The api-key sub-routes stay project-scoped via requireProjectId.
//
// Deliberately NOT pinning an edition: this runs under CI's cloud edition
// (CAPS.rbac on) — the edition the bug lived in and where `onecli auth login`
// with an org key matters. That means org-key auth performs the admin
// role re-check (api-key.ts), so the test registers a roleResolver, exactly
// as the real cloud stack does. Without it the org key would 401 at the role
// gate — masking whether the requireProject fix works at all.

const ORG_KEY = "oc_org_test-key";

const services = vi.hoisted(() => ({
  getUser: vi.fn(async () => ({
    email: "admin@example.com",
    name: "Admin",
  })),
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
  },
}));

vi.mock("../services/user-service", () => ({
  getUser: services.getUser,
  updateProfile: vi.fn(),
}));

const { createApiApp } = await import("../app");

const app = createApiApp(
  { getSession: async () => null },
  // The key's user still holds an admin role — the cloud org-key gate.
  { roleResolver: { getUserRole: async () => "owner" } },
);

const AUTH = { Authorization: `Bearer ${ORG_KEY}` };

describe("GET /v1/user auth posture", () => {
  it("answers an org key WITHOUT a project header (the auth login path)", async () => {
    const res = await app.request("/v1/user", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: "admin@example.com" });
  });

  it("keeps the project-scoped api-key sub-route fenced for org keys", async () => {
    const res = await app.request("/v1/user/api-key", { headers: AUTH });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("X-Project-Id");
  });

  it("still rejects an unknown key outright", async () => {
    const res = await app.request("/v1/user", {
      headers: { Authorization: "Bearer oc_org_nope" },
    });
    expect(res.status).toBe(401);
  });
});
