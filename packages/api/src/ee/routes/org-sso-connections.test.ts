import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../../types";

// Route-level authz tests: admin gate + enterprise feature gate over the
// mocked service layer (Cognito/Redis never touched).

const ORG_KEY = "oc_org_test-key";

// The router is injected explicitly below (SSO is cloud-only); the edition
// pin keeps the org-key auth path hermetic to the ambient env.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  process.env.SECRET_ENCRYPTION_KEY = "test-secret";
  process.env.OAUTH_STATE_SECRET = "test-secret";
});

const store = vi.hoisted(() => ({
  members: [] as { organizationId: string; userId: string; role: string }[],
  featureAllowed: true,
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === ORG_KEY
          ? { userId: "user-1", organizationId: "org-1", scope: "organization" }
          : null,
      // withAudit's built-in gateway flush enumerates org keys.
      findMany: async () => [],
    },
    user: {
      findUnique: async () => ({ email: "admin@example.com" }),
    },
    organizationMember: {
      findUnique: async ({
        where,
      }: {
        where: {
          organizationId_userId: { organizationId: string; userId: string };
        };
      }) => {
        const { organizationId, userId } = where.organizationId_userId;
        return (
          store.members.find(
            (m) => m.organizationId === organizationId && m.userId === userId,
          ) ?? null
        );
      },
    },
    auditLog: { create: async () => ({}) },
  },
}));

vi.mock("../services/quota-service", () => ({
  assertFeatureAllowed: async () => {
    if (!store.featureAllowed) {
      const { ServiceError } = await import("../../services/errors");
      throw new ServiceError("FORBIDDEN", "Requires the Enterprise plan");
    }
  },
}));

const serviceCalls = vi.hoisted(() => ({ list: 0, create: 0 }));

vi.mock("../sso/sso-connection-service", () => ({
  listConnections: async () => {
    serviceCalls.list += 1;
    return [];
  },
  createConnection: async () => {
    serviceCalls.create += 1;
    return {
      id: "conn-1",
      type: "saml",
      status: "pending",
      displayName: "Test",
      cognitoProviderName: "org-abc",
      config: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  },
  updateConnection: async () => ({
    id: "conn-1",
    type: "saml",
    status: "pending",
    displayName: "Test",
    cognitoProviderName: "org-abc",
    config: {},
  }),
  deleteConnection: async () => undefined,
  testConnection: async () => ({ ok: true, checks: [] }),
}));

import { createApiApp } from "../../app";
import { getUserRole } from "../services/authorization-service";
import { orgSsoConnectionRoutes } from "./org-sso-connections";

const nullSession = { getSession: async () => null };

let app: Hono<ApiEnv>;
beforeAll(() => {
  app = createApiApp(nullSession, {
    roleResolver: { getUserRole },
    eeRoutes: (a) => {
      a.route("/org/sso/connections", orgSsoConnectionRoutes());
    },
  });
});

const authed = { headers: { Authorization: `Bearer ${ORG_KEY}` } };

beforeEach(() => {
  store.members = [
    { organizationId: "org-1", userId: "user-1", role: "admin" },
  ];
  store.featureAllowed = true;
  serviceCalls.list = 0;
  serviceCalls.create = 0;
});

describe("GET /v1/org/sso/connections", () => {
  it("lists for admins without the feature gate", async () => {
    store.featureAllowed = false; // gate must not apply to reads
    const res = await app.request("/v1/org/sso/connections", authed);
    expect(res.status).toBe(200);
    expect(serviceCalls.list).toBe(1);
  });

  it("rejects an org key whose user is below admin (the demotion re-check)", async () => {
    store.members = [
      { organizationId: "org-1", userId: "user-1", role: "member" },
    ];
    const res = await app.request("/v1/org/sso/connections", authed);
    expect(res.status).toBe(401);
  });

  it("401s without credentials", async () => {
    const res = await app.request("/v1/org/sso/connections");
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/org/sso/connections", () => {
  const body = JSON.stringify({
    type: "oidc",
    displayName: "Acme",
    issuer: "https://login.acme.com",
    clientId: "cid",
    clientSecret: "cs",
  });

  it("creates for enterprise admins", async () => {
    const res = await app.request("/v1/org/sso/connections", {
      ...authed,
      method: "POST",
      body,
    });
    expect(res.status).toBe(201);
    expect(serviceCalls.create).toBe(1);
  });

  it("403s when the plan lacks the sso feature", async () => {
    store.featureAllowed = false;
    const res = await app.request("/v1/org/sso/connections", {
      ...authed,
      method: "POST",
      body,
    });
    expect(res.status).toBe(403);
    expect(serviceCalls.create).toBe(0);
  });

  it("400s on invalid bodies", async () => {
    const res = await app.request("/v1/org/sso/connections", {
      ...authed,
      method: "POST",
      body: JSON.stringify({ type: "saml", displayName: "x" }), // no metadata
    });
    expect(res.status).toBe(400);
  });
});

describe("lifecycle gating (create/enable gated; teardown never)", () => {
  it("PATCH {enabled: true} 403s without the feature (enabling recreates the IdP)", async () => {
    store.featureAllowed = false;
    const res = await app.request("/v1/org/sso/connections/conn-1", {
      ...authed,
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(403);
  });

  it("PATCH {enabled: false} succeeds with a lapsed plan — disable is never gated", async () => {
    store.featureAllowed = false;
    const res = await app.request("/v1/org/sso/connections/conn-1", {
      ...authed,
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
  });

  it("PATCH secret rotation succeeds with a lapsed plan — maintenance is not acquisition", async () => {
    store.featureAllowed = false;
    const res = await app.request("/v1/org/sso/connections/conn-1", {
      ...authed,
      method: "PATCH",
      body: JSON.stringify({ clientSecret: "rotated" }),
    });
    expect(res.status).toBe(200);
  });

  it("DELETE succeeds with a lapsed plan — teardown must survive a downgrade", async () => {
    store.featureAllowed = false;
    const res = await app.request("/v1/org/sso/connections/conn-1", {
      ...authed,
      method: "DELETE",
    });
    expect(res.status).toBe(204);
  });

  it("test endpoint stays gated", async () => {
    store.featureAllowed = false;
    const res = await app.request("/v1/org/sso/connections/conn-1/test", {
      ...authed,
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(403);
  });
});
