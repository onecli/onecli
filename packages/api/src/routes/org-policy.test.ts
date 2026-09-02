import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../types";

// Route-level tests for the unified policy API, exercised through the org
// router (which reuses the shared registerPolicyRoutes handlers): the admin
// gate, the discriminated-union validation → 422, status codes, and the
// ServiceError → status mapping. The service layer is mocked.

// Editing is gated off by default during the cutover; enable it for these
// mutation tests (the gate itself is covered separately).

const ORG_KEY = "oc_org_test-key";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  process.env.SECRET_ENCRYPTION_KEY = "test-secret";
  process.env.OAUTH_STATE_SECRET = "test-secret";
});

const store = vi.hoisted(() => ({
  members: [] as { organizationId: string; userId: string; role: string }[],
  throwOnCreate: null as null | "FORBIDDEN" | "UNPROCESSABLE",
  throwOnReorder: null as null | "CONFLICT",
  throwOnGet: null as null | "NOT_FOUND",
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

const calls = vi.hoisted(() => ({
  create: 0,
  reorder: 0,
  publish: 0,
  del: 0,
}));

vi.mock("../services/policy-service", async () => {
  const { ServiceError } = await import("../services/errors");
  const rule = {
    id: "r1",
    scope: "organization",
    status: "draft",
    generation: 0,
    priority: 1,
    enabled: true,
    isDefault: false,
    name: "R",
    description: null,
    action: "allow",
    rateLimit: null,
    rateLimitWindow: null,
    requireApproval: false,
    conditions: null,
    identities: [],
    targets: [],
    createdAt: new Date(),
  };
  return {
    listPolicyRules: async () => [rule],
    getPolicyRule: async () => {
      if (store.throwOnGet) throw new ServiceError(store.throwOnGet, "nope");
      return rule;
    },
    createPolicyRule: async () => {
      if (store.throwOnCreate)
        throw new ServiceError(store.throwOnCreate, "gated");
      calls.create += 1;
      return rule;
    },
    updatePolicyRule: async () => rule,
    deletePolicyRule: async () => {
      calls.del += 1;
    },
    reorderPolicyRules: async () => {
      if (store.throwOnReorder)
        throw new ServiceError(store.throwOnReorder, "stale");
      calls.reorder += 1;
      return [rule];
    },
    getPolicyDefault: async () => ({ ...rule, id: "d1", isDefault: true }),
    setPolicyDefaultAction: async () => ({
      ...rule,
      id: "d1",
      isDefault: true,
      action: "block",
    }),
    publishPolicy: async () => {
      calls.publish += 1;
      return { generation: 1, ruleCount: 1 };
    },
  };
});

import { createApiApp } from "../app";
import { getUserRole } from "../ee/services/authorization-service";

const nullSession = { getSession: async () => null };

let app: Hono<ApiEnv>;
beforeAll(() => {
  // `/org/policy` is mounted by the shared block in `createApiApp` since the
  // licensing split; mounting it again here would run its admin middleware twice.
  app = createApiApp(nullSession, { roleResolver: { getUserRole } });
});

const authed = { headers: { Authorization: `Bearer ${ORG_KEY}` } };

const post = (path: string, body: unknown) => ({
  ...authed,
  method: "POST",
  body: JSON.stringify(body),
});

beforeEach(() => {
  store.members = [
    { organizationId: "org-1", userId: "user-1", role: "admin" },
  ];
  store.throwOnCreate = null;
  store.throwOnReorder = null;
  store.throwOnGet = null;
  calls.create = 0;
  calls.reorder = 0;
  calls.publish = 0;
  calls.del = 0;
});

const validRule = {
  name: "Allow Gmail read",
  action: "allow",
  identities: [{ type: "agent", id: "agent-1" }],
  targets: [{ kind: "app", provider: "gmail", tools: ["read"] }],
};

describe("authz", () => {
  it("lists rules for admins", async () => {
    const res = await app.request("/v1/org/policy/rules", authed);
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });

  it("accepts ?status=published", async () => {
    const res = await app.request(
      "/v1/org/policy/rules?status=published",
      authed,
    );
    expect(res.status).toBe(200);
  });

  it("422s an invalid ?status", async () => {
    const res = await app.request("/v1/org/policy/rules?status=bogus", authed);
    expect(res.status).toBe(422);
  });

  it("rejects an org key whose user is below admin (the demotion re-check)", async () => {
    store.members = [
      { organizationId: "org-1", userId: "user-1", role: "member" },
    ];
    const res = await app.request("/v1/org/policy/rules", authed);
    expect(res.status).toBe(401);
  });

  it("401s without credentials", async () => {
    const res = await app.request("/v1/org/policy/rules");
    expect(res.status).toBe(401);
  });
});

describe("POST /rules", () => {
  it("creates a rule (201)", async () => {
    const res = await app.request("/v1/org/policy/rules", post("/", validRule));
    expect(res.status).toBe(201);
    expect(calls.create).toBe(1);
  });

  it("422s when an identity omits its type (discriminated union)", async () => {
    const res = await app.request(
      "/v1/org/policy/rules",
      post("/", { ...validRule, identities: [{ id: "agent-1" }] }),
    );
    expect(res.status).toBe(422);
    expect(calls.create).toBe(0);
  });

  it("422s when an app target omits its provider (kind shape)", async () => {
    const res = await app.request(
      "/v1/org/policy/rules",
      post("/", { ...validRule, targets: [{ kind: "app" }] }),
    );
    expect(res.status).toBe(422);
  });

  it("422s when modifiers are set on a block action", async () => {
    const res = await app.request(
      "/v1/org/policy/rules",
      post("/", { name: "B", action: "block", requireApproval: true }),
    );
    expect(res.status).toBe(422);
  });

  it("422s when rateLimit is set without a window", async () => {
    const res = await app.request(
      "/v1/org/policy/rules",
      post("/", { name: "R", action: "allow", rateLimit: 10 }),
    );
    expect(res.status).toBe(422);
  });

  it("403s when the plan gate rejects a paid modifier", async () => {
    store.throwOnCreate = "FORBIDDEN";
    const res = await app.request(
      "/v1/org/policy/rules",
      post("/", { ...validRule, requireApproval: true }),
    );
    expect(res.status).toBe(403);
  });
});

describe("item ops", () => {
  it("404s an unknown rule", async () => {
    store.throwOnGet = "NOT_FOUND";
    const res = await app.request("/v1/org/policy/rules/nope", authed);
    expect(res.status).toBe(404);
  });

  it("deletes a rule (204)", async () => {
    const res = await app.request("/v1/org/policy/rules/r1", {
      ...authed,
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(calls.del).toBe(1);
  });
});

describe("PUT /rules/order", () => {
  it("reorders (200)", async () => {
    const res = await app.request("/v1/org/policy/rules/order", {
      ...authed,
      method: "PUT",
      body: JSON.stringify({ orderedIds: ["r1"] }),
    });
    expect(res.status).toBe(200);
    expect(calls.reorder).toBe(1);
  });

  it("422s an empty order", async () => {
    const res = await app.request("/v1/org/policy/rules/order", {
      ...authed,
      method: "PUT",
      body: JSON.stringify({ orderedIds: [] }),
    });
    expect(res.status).toBe(422);
  });

  it("409s a stale rule set", async () => {
    store.throwOnReorder = "CONFLICT";
    const res = await app.request("/v1/org/policy/rules/order", {
      ...authed,
      method: "PUT",
      body: JSON.stringify({ orderedIds: ["r1"] }),
    });
    expect(res.status).toBe(409);
  });
});

describe("default + publish", () => {
  it("gets the default rule", async () => {
    const res = await app.request("/v1/org/policy/default", authed);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ isDefault: true });
  });

  it("sets the default action", async () => {
    const res = await app.request("/v1/org/policy/default", {
      ...authed,
      method: "PATCH",
      body: JSON.stringify({ action: "block" }),
    });
    expect(res.status).toBe(200);
  });

  it("422s an invalid default action", async () => {
    const res = await app.request("/v1/org/policy/default", {
      ...authed,
      method: "PATCH",
      body: JSON.stringify({ action: "rate_limit" }),
    });
    expect(res.status).toBe(422);
  });

  it("publishes the draft set (200)", async () => {
    const res = await app.request("/v1/org/policy/publish", {
      ...authed,
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ generation: 1, ruleCount: 1 });
    expect(calls.publish).toBe(1);
  });
});
