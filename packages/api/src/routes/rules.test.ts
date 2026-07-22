import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../types";

// The legacy /v1/rules CUSTOM-rule writes AND the app-permission write
// (PUT /permissions/:provider) must fail LOUD (410 Gone) once v2 policy editing
// is live, so a CLI/SDK write can't silently land in the old model the gateway
// no longer reads (post-adoption the bridge no longer re-derives app-permission
// rows either — that write would be a silent no-op). Reads stay open. With the
// flag off (OSS / pre-flip) all writes pass through unchanged. Project scope via
// an org key + the X-Project-Id header (onprem-slim pins CAPS.rbac off, so no
// role resolver needed).

const ORG = "org-1";
const PROJECT = "proj-1";
const ORG_KEY = "oc_org_test-key";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem-slim";
  process.env.SECRET_ENCRYPTION_KEY = "test-secret";
  process.env.OAUTH_STATE_SECRET = "test-secret";
});

const calls = vi.hoisted(() => ({ create: 0, update: 0, del: 0 }));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key?: string } }) =>
        where.key === ORG_KEY
          ? { userId: "user-1", organizationId: ORG, scope: "organization" }
          : null,
      findFirst: async () => null,
      findMany: async () => [],
    },
    user: {
      findUnique: async ({ select }: { select?: Record<string, unknown> }) =>
        select?.organizationMemberships
          ? { organizationMemberships: [{ organizationId: ORG }] }
          : { id: "user-1", email: "admin@example.com" },
    },
    organizationMember: {
      findFirst: async () => ({ organizationId: ORG }),
      findUnique: async () => ({ organizationId: ORG, role: "admin" }),
    },
    project: {
      findFirst: async ({ where }: { where?: { id?: string } }) =>
        where?.id
          ? where.id === PROJECT
            ? { id: where.id, organizationId: ORG, createdByUserId: "user-1" }
            : null
          : { id: PROJECT, organizationId: ORG },
      findUnique: async () => ({ organizationId: ORG }),
    },
    auditLog: { create: async () => ({}) },
  },
}));

vi.mock("../services/policy-rule-service", () => {
  const rule = { id: "r1", name: "R", action: "block" };
  return {
    listPolicyRules: async () => [rule],
    getPolicyRule: async () => rule,
    createPolicyRule: async () => {
      calls.create += 1;
      return rule;
    },
    updatePolicyRule: async () => {
      calls.update += 1;
      return rule;
    },
    deletePolicyRule: async () => {
      calls.del += 1;
    },
    listAppPermissionRules: async () => [],
    setAppPermissionsService: async () => ({}),
    buildAppPermissionStates: () => ({ defaults: {}, byAgent: {} }),
    resolvePermissionChanges: () => ({ resolved: [] }),
    countOverlappingRulesForApp: async () => 0,
    providerDisplayName: () => "Gmail",
  };
});

import { createApiApp } from "../app";

const nullSession = { getSession: async () => null };

let app: Hono<ApiEnv>;
beforeAll(() => {
  app = createApiApp(nullSession);
});

const authed = {
  headers: { Authorization: `Bearer ${ORG_KEY}`, "x-project-id": PROJECT },
};
const validRule = {
  name: "R",
  hostPattern: "api.example.com",
  action: "block",
  enabled: true,
};

beforeEach(() => {
  calls.create = 0;
  calls.update = 0;
  calls.del = 0;
});

describe("legacy /v1/rules deprecation gate — v2 editing ON", () => {
  beforeEach(() => {
    process.env.POLICY_EDITING_ENABLED = "1";
  });

  it("410s POST (create custom rule) before the service is touched", async () => {
    const res = await app.request("/v1/rules", {
      ...authed,
      method: "POST",
      body: JSON.stringify(validRule),
    });
    expect(res.status).toBe(410);
    expect(calls.create).toBe(0);
  });

  it("410s PATCH", async () => {
    const res = await app.request("/v1/rules/r1", {
      ...authed,
      method: "PATCH",
      body: JSON.stringify({ action: "allow" }),
    });
    expect(res.status).toBe(410);
    expect(calls.update).toBe(0);
  });

  it("410s DELETE", async () => {
    const res = await app.request("/v1/rules/r1", {
      ...authed,
      method: "DELETE",
    });
    expect(res.status).toBe(410);
    expect(calls.del).toBe(0);
  });

  it("keeps reads open (GET)", async () => {
    const res = await app.request("/v1/rules", authed);
    expect(res.status).toBe(200);
  });

  it("410s the app-permission write (PUT /permissions) — adopted, no longer bridged", async () => {
    // Gate fires BEFORE the handler (even an unknown provider 410s, not 400s).
    const res = await app.request("/v1/rules/permissions/unknown-xyz", {
      ...authed,
      method: "PUT",
      body: JSON.stringify({ changes: [{ toolId: "t", permission: "block" }] }),
    });
    expect(res.status).toBe(410);
  });

  it("keeps the app-permission read open (GET /permissions)", async () => {
    const res = await app.request("/v1/rules/permissions/unknown-xyz", authed);
    expect(res.status).toBe(200);
  });
});

describe("legacy /v1/rules gate — v2 editing OFF (OSS / pre-flip)", () => {
  beforeEach(() => {
    process.env.POLICY_EDITING_ENABLED = "";
  });

  it("passes writes through to the service unchanged", async () => {
    const res = await app.request("/v1/rules", {
      ...authed,
      method: "POST",
      body: JSON.stringify(validRule),
    });
    expect(res.status).toBe(201);
    expect(calls.create).toBe(1);
  });

  it("passes the app-permission write through unchanged (no 410 pre-cutover)", async () => {
    // Unknown provider → the handler's own 400 — proof the gate didn't fire
    // and the handler ran (OSS byte-identity for the legacy surface).
    const res = await app.request("/v1/rules/permissions/unknown-xyz", {
      ...authed,
      method: "PUT",
      body: JSON.stringify({ changes: [{ toolId: "t", permission: "block" }] }),
    });
    expect(res.status).toBe(400);
  });
});
