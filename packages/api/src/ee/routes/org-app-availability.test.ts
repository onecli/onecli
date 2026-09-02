import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../../types";

// Route-level tests for the org app-availability API: the admin gate, the
// editing-flag gate, the enterprise plan gate, the union validation → 422, and
// delegation to the service (which is mocked). The service's own ownership +
// derivation logic is covered in app-availability-service.test.ts.

const ORG_KEY = "oc_org_test-key";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  process.env.SECRET_ENCRYPTION_KEY = "test-secret";
  process.env.OAUTH_STATE_SECRET = "test-secret";
});

const store = vi.hoisted(() => ({
  members: [] as { organizationId: string; userId: string; role: string }[],
  featureAllowed: true,
  lastSetInput: null as unknown,
  setCalls: 0,
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === ORG_KEY
          ? { userId: "user-1", organizationId: "org-1", scope: "organization" }
          : null,
      findMany: async () => [], // withAudit's gateway flush enumerates keys
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

vi.mock("../services/quota-service", async () => {
  const { ServiceError } = await import("../../services/errors");
  return {
    assertFeatureAllowed: async () => {
      if (!store.featureAllowed)
        throw new ServiceError(
          "FORBIDDEN",
          "This feature requires Enterprise.",
        );
    },
  };
});

vi.mock("../services/app-availability-service", () => ({
  getAppAvailability: async () => ({ mode: "open", rules: [] }),
  setAppAvailability: async (
    _orgId: string,
    input: unknown,
  ): Promise<unknown> => {
    store.setCalls += 1;
    store.lastSetInput = input;
    return input;
  },
}));

import { createApiApp } from "../../app";
import { getUserRole } from "../services/authorization-service";
import { orgAppAvailabilityRoutes } from "./org-app-availability";

const nullSession = { getSession: async () => null };

let app: Hono<ApiEnv>;
beforeAll(() => {
  app = createApiApp(nullSession, {
    roleResolver: { getUserRole },
    eeRoutes: (a) => {
      a.route("/org/app-availability", orgAppAvailabilityRoutes());
    },
  });
});

const authed = { headers: { Authorization: `Bearer ${ORG_KEY}` } };
const put = (body: unknown) => ({
  ...authed,
  method: "PUT",
  body: JSON.stringify(body),
});

beforeEach(() => {
  store.members = [
    { organizationId: "org-1", userId: "user-1", role: "admin" },
  ];
  store.featureAllowed = true;
  store.lastSetInput = null;
  store.setCalls = 0;
});

const validBody = {
  mode: "restricted",
  rules: [
    {
      name: "People apps",
      userIds: ["u1"],
      groupIds: ["g1"],
      providers: ["gmail", "slack"],
    },
    { userIds: [], groupIds: ["g2"], providers: ["github"] },
  ],
};

describe("authz", () => {
  it("reads config for admins", async () => {
    const res = await app.request("/v1/org/app-availability", authed);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "open", rules: [] });
  });

  it("rejects reads for an org key whose user is below admin (the demotion re-check)", async () => {
    store.members = [
      { organizationId: "org-1", userId: "user-1", role: "member" },
    ];
    const res = await app.request("/v1/org/app-availability", authed);
    expect(res.status).toBe(401);
  });

  it("401s without credentials", async () => {
    const res = await app.request("/v1/org/app-availability");
    expect(res.status).toBe(401);
  });

  it("rejects a write for an org key whose user is below admin — nothing persists", async () => {
    store.members = [
      { organizationId: "org-1", userId: "user-1", role: "member" },
    ];
    const res = await app.request("/v1/org/app-availability", put(validBody));
    expect(res.status).toBe(401);
    expect(store.setCalls).toBe(0);
  });
});

describe("enterprise gate", () => {
  it("403s a restricting write for a non-enterprise org", async () => {
    store.featureAllowed = false;
    const res = await app.request("/v1/org/app-availability", put(validBody));
    expect(res.status).toBe(403);
    expect(store.setCalls).toBe(0);
  });

  it("still lets a non-enterprise org reset to open (the escape hatch)", async () => {
    store.featureAllowed = false;
    const res = await app.request(
      "/v1/org/app-availability",
      put({ mode: "open", rules: [] }),
    );
    expect(res.status).toBe(200);
    expect(store.setCalls).toBe(1);
  });
});

describe("validation", () => {
  it("422s a bad mode", async () => {
    const res = await app.request(
      "/v1/org/app-availability",
      put({ mode: "bogus", rules: [] }),
    );
    expect(res.status).toBe(422);
    expect(store.setCalls).toBe(0);
  });

  it("422s a malformed rule (non-array identities)", async () => {
    const res = await app.request(
      "/v1/org/app-availability",
      put({
        mode: "restricted",
        rules: [{ userIds: "u1", groupIds: [], providers: ["gmail"] }],
      }),
    );
    expect(res.status).toBe(422);
    expect(store.setCalls).toBe(0);
  });
});

describe("write", () => {
  it("persists a valid config and echoes it back", async () => {
    const res = await app.request("/v1/org/app-availability", put(validBody));
    expect(res.status).toBe(200);
    expect(store.setCalls).toBe(1);
    expect(store.lastSetInput).toEqual(validBody);
  });
});
