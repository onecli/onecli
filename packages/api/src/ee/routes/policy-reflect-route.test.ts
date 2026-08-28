import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../../types";

// Route-level contracts for the step-9.7b reflection endpoints: the flag gate
// (403 flag-off, service never reached), input validation, the ROLE→redaction
// wiring (member → viewerSeesOrgRules=false, admin → true, null fails safe),
// and the org variant's admin-only gate. The services are mocked; their own
// behavior (agreement law, fences, redaction bait) is covered in
// effective-tools.test.ts.

const PROJ_KEY = "oc_test-workspace-key";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  process.env.SECRET_ENCRYPTION_KEY = "test-secret";
  process.env.OAUTH_STATE_SECRET = "test-secret";
});

const store = vi.hoisted(() => ({
  role: "member" as string | null,
  /** When set, each role read consults this instead of `role` — lets a test
   * vary the role BETWEEN the auth middleware and the handler's own check. */
  roleSequencer: null as null | (() => string | null),
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === PROJ_KEY ? { userId: "user-1", workspaceId: "p1" } : null,
      findMany: async () => [],
    },
    workspace: {
      findUnique: async () => ({ id: "p1", organizationId: "org-1" }),
      findFirst: async () => ({ id: "p1" }),
    },
    workspaceAccess: {
      findFirst: async () => ({ id: "pa1" }),
    },
    user: { findUnique: async () => ({ email: "member@example.com" }) },
    organizationMember: {
      findUnique: async () => {
        const role = store.roleSequencer ? store.roleSequencer() : store.role;
        return role === null ? null : { role, status: "active" };
      },
    },
    auditLog: { create: async () => ({}) },
  },
}));

const reflectCalls = vi.hoisted(() => ({
  ctxs: [] as {
    scope: string;
    viewerSeesOrgRules: boolean;
    workspaceId?: string;
  }[],
  inputs: [] as { provider: string; agentId?: string }[],
}));

vi.mock("../../services/policy-reflect/effective-tools", () => ({
  effectiveAppPermissions: async (
    input: { provider: string; agentId?: string },
    ctx: { scope: string; viewerSeesOrgRules: boolean; workspaceId?: string },
  ) => {
    reflectCalls.inputs.push(input);
    reflectCalls.ctxs.push(ctx);
    return {
      provider: input.provider,
      basis: { agentId: null, credentialAttached: false, scope: ctx.scope },
      variesByIdentity: 0,
      groups: [],
    };
  },
}));

const credentialCalls = vi.hoisted(() => ({
  ctxs: [] as { viewerSeesOrgRules: boolean; workspaceId: string }[],
}));

vi.mock("../../services/policy-reflect/effective-credentials", () => ({
  effectiveCredentials: async (
    agentId: string,
    ctx: { viewerSeesOrgRules: boolean; workspaceId: string },
  ) => {
    credentialCalls.ctxs.push(ctx);
    return {
      agentId,
      mode: "selective",
      pool: null,
      secrets: [],
      connections: [],
    };
  },
}));

const connectionCalls = vi.hoisted(() => ({
  ctxs: [] as { viewerSeesOrgRules: boolean; workspaceId: string }[],
}));

vi.mock("../../services/policy-reflect/effective-agents", () => ({
  effectiveAgents: async (
    connectionId: string,
    ctx: { viewerSeesOrgRules: boolean; workspaceId: string },
  ) => {
    connectionCalls.ctxs.push(ctx);
    return { connectionId, provider: "gmail", catalog: true, agents: [] };
  },
}));

import { createApiApp } from "../../app";
import { getUserRole } from "../services/authorization-service";
import { orgPolicyReflectRoutes } from "../../routes/policy-reflect";

const nullSession = { getSession: async () => null };

let app: Hono<ApiEnv>;
beforeAll(() => {
  // The workspace/agent/connection reflections mount in the shared app.ts (step
  // 10 — OSS gets them too); only the org-scoped one is registered via eeRoutes.
  // The roleResolver is EE-configured here so the admin-sees-org-rules path is
  // exercised.
  app = createApiApp(nullSession, {
    roleResolver: { getUserRole },
    eeRoutes: (a) => {
      a.route("/org/policy", orgPolicyReflectRoutes());
    },
  });
});

const getEffective = (query: string) =>
  app.request(`/v1/policy/effective-app-permissions?${query}`, {
    headers: { Authorization: `Bearer ${PROJ_KEY}`, "X-Workspace-Id": "p1" },
  });

const getOrgEffective = (query: string) =>
  app.request(`/v1/org/policy/effective-app-permissions?${query}`, {
    headers: { Authorization: `Bearer ${PROJ_KEY}` },
  });

beforeEach(() => {
  store.role = "member";
  store.roleSequencer = null;
  reflectCalls.ctxs = [];
  reflectCalls.inputs = [];
  credentialCalls.ctxs = [];
  connectionCalls.ctxs = [];
});

describe("GET /v1/policy/effective-app-permissions", () => {
  it("a MEMBER caller reads with org rules redacted", async () => {
    const res = await getEffective("provider=gmail&agentId=agent-1");
    expect(res.status).toBe(200);
    expect(reflectCalls.ctxs[0]).toMatchObject({
      scope: "workspace",
      workspaceId: "p1",
      viewerSeesOrgRules: false,
    });
    expect(reflectCalls.inputs[0]).toEqual({
      provider: "gmail",
      agentId: "agent-1",
    });
  });

  it("an ADMIN caller sees org rules", async () => {
    store.role = "admin";
    const res = await getEffective("provider=gmail");
    expect(res.status).toBe(200);
    expect(reflectCalls.ctxs[0]).toMatchObject({ viewerSeesOrgRules: true });
  });

  it("422s a missing provider", async () => {
    const res = await getEffective("agentId=agent-1");
    expect(res.status).toBe(422);
    expect(reflectCalls.ctxs).toHaveLength(0);
  });

  it("401s without credentials", async () => {
    const res = await app.request(
      "/v1/policy/effective-app-permissions?provider=gmail",
    );
    expect(res.status).toBe(401);
  });

  it("a null role AFTER auth fails safe to non-admin", async () => {
    let roleReads = 0;
    store.roleSequencer = () => {
      roleReads += 1;
      return roleReads <= 2 ? "member" : null;
    };
    const res = await getEffective("provider=gmail");
    expect(res.status).toBe(200);
    expect(reflectCalls.ctxs[0]).toMatchObject({ viewerSeesOrgRules: false });
  });
});

describe("GET /v1/agents/:agentId/effective-credentials", () => {
  const get = () =>
    app.request("/v1/agents/agent-1/effective-credentials", {
      headers: { Authorization: `Bearer ${PROJ_KEY}`, "X-Workspace-Id": "p1" },
    });

  it("serves WORKSPACE MEMBERS with org provenance redacted (not admin-gated)", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(credentialCalls.ctxs[0]).toMatchObject({
      workspaceId: "p1",
      viewerSeesOrgRules: false,
    });
  });

  it("an ADMIN caller sees org provenance", async () => {
    store.role = "admin";
    const res = await get();
    expect(res.status).toBe(200);
    expect(credentialCalls.ctxs[0]).toMatchObject({
      viewerSeesOrgRules: true,
    });
  });

  it("401s without credentials", async () => {
    const res = await app.request("/v1/agents/agent-1/effective-credentials");
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/connections/:connectionId/effective-agents", () => {
  const get = () =>
    app.request("/v1/connections/conn-1/effective-agents", {
      headers: { Authorization: `Bearer ${PROJ_KEY}`, "X-Workspace-Id": "p1" },
    });

  it("serves WORKSPACE MEMBERS with org provenance redacted", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(connectionCalls.ctxs[0]).toMatchObject({
      workspaceId: "p1",
      viewerSeesOrgRules: false,
    });
  });

  it("401s without credentials", async () => {
    const res = await app.request("/v1/connections/conn-1/effective-agents");
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/org/policy/effective-app-permissions", () => {
  it("403s for members (org-admin only)", async () => {
    const res = await getOrgEffective("provider=gmail");
    expect(res.status).toBe(403);
    expect(reflectCalls.ctxs).toHaveLength(0);
  });

  it("serves admins at org scope, agent-less", async () => {
    store.role = "admin";
    const res = await getOrgEffective("provider=gmail");
    expect(res.status).toBe(200);
    expect(reflectCalls.ctxs[0]).toMatchObject({
      scope: "organization",
      viewerSeesOrgRules: true,
    });
    expect(reflectCalls.inputs[0]).toEqual({ provider: "gmail" });
  });
});
