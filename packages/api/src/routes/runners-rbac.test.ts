import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgRole } from "../providers";

// The OTHER arm of `GET /v1/runners`. Where roles exist — cloud, and any
// self-host with the enterprise entitlement, which is a deployment that
// really does run runners — the fleet view is admin-only: names are usually
// hostnames and `sandboxCount` is a deployment-wide total, so an ordinary
// member of one org must not read another org's fleet usage from it.
//
// A separate file because the capability set is resolved once at module load,
// so the two arms cannot be exercised in one process. The permissive arm
// (roles absent → any authenticated caller) lives in runner.test.ts.

// A SESSION, not an org key: with RBAC on, an `oc_org_` key is itself an
// admin capability (api-key.ts re-checks the holder's role), so a member can
// never present one — which would test the key check rather than this route's
// own gate.
const ORG_ID = "org-1";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  process.env.SECRET_ENCRYPTION_KEY = "test-secret";
});

const store = vi.hoisted(() => ({ role: "admin" as OrgRole }));
const services = vi.hoisted(() => ({ listRunners: vi.fn() }));

// Catch-all so the cloud composition root's own reads (the SSO session
// enforcer among them) resolve to "nothing" instead of throwing — this suite
// is about one route's role gate, not about everything cloud touches on the
// way in.
vi.mock("@onecli/db", () => {
  const empty = {
    findFirst: async () => null,
    findUnique: async () => null,
    findMany: async () => [],
    count: async () => 0,
    create: async () => ({}),
    update: async () => ({}),
    updateMany: async () => ({ count: 0 }),
  };
  const overrides: Record<string, unknown> = {
    user: {
      ...empty,
      findUnique: async () => ({ id: "user-1", email: "member@example.com" }),
    },
    organizationMember: {
      ...empty,
      findFirst: async () => ({ organizationId: ORG_ID }),
      findUnique: async () => ({
        organizationId: ORG_ID,
        userId: "user-1",
        role: store.role,
      }),
    },
  };
  return {
    Prisma: {},
    db: new Proxy(
      {},
      { get: (_target, name: string) => overrides[name] ?? empty },
    ),
  };
});

vi.mock("../services/runner-service", () => ({
  listRunners: services.listRunners,
  // The unauthenticated /v1/instance route reads this at app construction.
  getRunnerAvailability: async () => ({ registered: false, online: false }),
  registerRunner: vi.fn(),
  heartbeatRunner: vi.fn(),
}));

const { createApiApp } = await import("../app");
const { CAPS } = await import("../lib/env");

const app = createApiApp(
  {
    getSession: async () => ({
      id: "ext-user-1",
      email: "member@example.com",
    }),
  },
  { roleResolver: { getUserRole: async () => store.role } },
);

// The org comes from the header for a session with no workspace scope.
const AUTH = { "x-organization-id": ORG_ID };

beforeEach(() => {
  services.listRunners.mockReset();
  services.listRunners.mockResolvedValue([]);
  store.role = "admin";
});

describe("GET /v1/runners where roles are enforced", () => {
  it("is running with rbac on (the premise of this file)", () => {
    expect(CAPS.rbac).toBe(true);
  });

  it("lets an admin read the fleet", async () => {
    const res = await app.request("/v1/runners", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(services.listRunners).toHaveBeenCalled();
  });

  it("REFUSES a plain member — fleet metadata is deployment-wide", async () => {
    store.role = "member";

    const res = await app.request("/v1/runners", { headers: AUTH });

    expect(res.status).toBe(403);
    // Refused before the read, so nothing about the fleet is computed.
    expect(services.listRunners).not.toHaveBeenCalled();
  });

  // Wrong-family refusal (an `rnr_` token on this route) is asserted in
  // runner.test.ts, where the session provider returns null — here every
  // request carries a stub session by construction.
});
