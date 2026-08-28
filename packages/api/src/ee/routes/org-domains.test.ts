import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../../types";

// Route-level authz tests over a mocked service layer, mirroring
// org-sso-connections.test.ts: admin gate + the enterprise feature gate —
// adds and verifies are gated, deletion never is (teardown must survive a
// plan lapse or a downgraded org stays steered into SSO by its domain).

const ORG_KEY = "oc_org_test-key";

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

const serviceCalls = vi.hoisted(() => ({
  list: 0,
  create: 0,
  verify: 0,
  remove: 0,
}));

vi.mock("../services/org-domain-service", () => ({
  listDomains: async () => {
    serviceCalls.list += 1;
    return [];
  },
  createDomain: async () => {
    serviceCalls.create += 1;
    return { id: "dom-1", domain: "acme.com" };
  },
  verifyDomain: async () => {
    serviceCalls.verify += 1;
    return { id: "dom-1", domain: "acme.com", verifiedAt: new Date() };
  },
  deleteDomain: async () => {
    serviceCalls.remove += 1;
  },
}));

import { createApiApp } from "../../app";
import { getUserRole } from "../services/authorization-service";
import { orgDomainRoutes } from "./org-domains";

const nullSession = { getSession: async () => null };

let app: Hono<ApiEnv>;
beforeAll(() => {
  app = createApiApp(nullSession, {
    roleResolver: { getUserRole },
    eeRoutes: (a) => {
      a.route("/org/domains", orgDomainRoutes());
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
  serviceCalls.verify = 0;
  serviceCalls.remove = 0;
});

describe("GET /v1/org/domains", () => {
  it("lists for admins without the feature gate", async () => {
    store.featureAllowed = false; // gate must not apply to reads
    const res = await app.request("/v1/org/domains", authed);
    expect(res.status).toBe(200);
    expect(serviceCalls.list).toBe(1);
  });

  it("rejects an org key whose user is below admin (the demotion re-check)", async () => {
    store.members = [
      { organizationId: "org-1", userId: "user-1", role: "member" },
    ];
    const res = await app.request("/v1/org/domains", authed);
    expect(res.status).toBe(401);
  });
});

describe("lifecycle gating (add/verify gated; deletion never)", () => {
  it("POST 403s without the feature", async () => {
    store.featureAllowed = false;
    const res = await app.request("/v1/org/domains", {
      ...authed,
      method: "POST",
      body: JSON.stringify({ domain: "acme.com" }),
    });
    expect(res.status).toBe(403);
    expect(serviceCalls.create).toBe(0);
  });

  it("creates for enterprise admins", async () => {
    const res = await app.request("/v1/org/domains", {
      ...authed,
      method: "POST",
      body: JSON.stringify({ domain: "acme.com" }),
    });
    expect(res.status).toBe(201);
    expect(serviceCalls.create).toBe(1);
  });

  it("verify 403s without the feature", async () => {
    store.featureAllowed = false;
    const res = await app.request("/v1/org/domains/dom-1/verify", {
      ...authed,
      method: "POST",
    });
    expect(res.status).toBe(403);
    expect(serviceCalls.verify).toBe(0);
  });

  it("DELETE succeeds with a lapsed plan — teardown must survive a downgrade", async () => {
    store.featureAllowed = false;
    const res = await app.request("/v1/org/domains/dom-1", {
      ...authed,
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(serviceCalls.remove).toBe(1);
  });
});
