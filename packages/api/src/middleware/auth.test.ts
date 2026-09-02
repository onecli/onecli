import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ApiEnv } from "../types";

// The auth middleware bridges scope carried in the query string
// (_token/_workspace/_org) into the request headers so browser navigations that
// can't set headers — the app-connect → GET /v1/apps/:provider/authorize
// redirect — still resolve the right workspace. The regression these guard: with
// local auth the session is ambient (no _token JWT), so before the fix the
// _workspace param was ignored and the authorize fell back to the user's default
// workspace. Pin to oss so header-less requests fall back to the default workspace
// (CAPS.tenancy is org-per-user) and CAPS.rbac is off.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

// The role gate branches on CAPS.rbac (flat team vs enforced roles). CAPS is
// captured at lib/env load, so the tests flip it through a mutable getter.
const caps = vi.hoisted(() => ({ rbac: false }));

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

const USER = "user-1";
const ORG = "org-1";
const TARGET_WORKSPACE = "proj-target";
const DEFAULT_WORKSPACE = "proj-default";

// Togglable membership: the role-gate tests plant a NON-member to prove the
// membership fence (org/workspace resolution), not the role comparison, is
// what keeps outsiders off flat-team deployments.
const membership = vi.hoisted(() => ({ active: true }));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === "oc_org_k1"
          ? { userId: USER, organizationId: ORG, scope: "organization" }
          : null,
    },
    user: {
      findUnique: async ({ select }: { select?: Record<string, unknown> }) =>
        select?.organizationMemberships
          ? {
              organizationMemberships: membership.active
                ? [{ organizationId: ORG }]
                : [],
            }
          : { id: USER, email: "owner@example.test" },
    },
    organizationMember: {
      findFirst: async () =>
        membership.active ? { organizationId: ORG } : null,
    },
    workspace: {
      // Header path (resolveWorkspaceId) queries by id; the default-workspace
      // fallback (findUserDefaultWorkspace) queries by createdByUserId.
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where?.id
          ? { id: where.id, organizationId: ORG, createdByUserId: USER }
          : { id: DEFAULT_WORKSPACE, organizationId: ORG },
      findUnique: async () => ({ organizationId: ORG }),
    },
  },
}));

import { auth } from "./auth";
import { initSession } from "../providers/session";
import { initSessionEnforcer } from "../providers/session-enforcer";
import { initRoleResolver } from "../providers/role-resolver";

const makeApp = () => {
  const app = new Hono<ApiEnv>();
  app.get("/echo", auth({ requireWorkspace: false }), (c) =>
    c.json({ workspaceId: c.get("auth").workspaceId }),
  );
  return app;
};

describe("auth middleware — scope query-param bridge", () => {
  describe("ambient session (OSS local auth, no _token)", () => {
    // Mirrors the local-auth session provider: authenticated regardless of the
    // request (it reads the ambient Next.js session, not the passed request).
    beforeEach(() =>
      initSession({
        getSession: async () => ({
          id: "session-sub-1",
          email: "owner@example.test",
        }),
      }),
    );

    it("bridges ?_workspace into the workspace scope", async () => {
      const res = await makeApp().request(
        `/echo?_workspace=${TARGET_WORKSPACE}`,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ workspaceId: TARGET_WORKSPACE });
    });

    it("falls back to the default workspace without ?_workspace", async () => {
      const res = await makeApp().request("/echo");
      expect(await res.json()).toEqual({ workspaceId: DEFAULT_WORKSPACE });
    });

    it("does not let ?_workspace override a real x-workspace-id header", async () => {
      const res = await makeApp().request("/echo?_workspace=proj-evil", {
        headers: { "x-workspace-id": TARGET_WORKSPACE },
      });
      expect(await res.json()).toEqual({ workspaceId: TARGET_WORKSPACE });
    });

    it("degrades a malformed scope param to the default (no 500)", async () => {
      // A non-Latin1 value (emoji, %F0%9F%98%80) makes Headers.set throw; the
      // bridge must swallow it and authenticate as if the param were absent,
      // not surface a 500.
      const res = await makeApp().request("/echo?_workspace=%F0%9F%98%80");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ workspaceId: DEFAULT_WORKSPACE });
    });
  });

  describe("query-token session (cloud browser navigation)", () => {
    // Mirrors a header-reading (JWT) provider: authenticated only when the
    // bridged Authorization is present — proving _token → Authorization works.
    beforeEach(() =>
      initSession({
        getSession: async (req) =>
          req.headers.get("authorization") === "Bearer jwt-123"
            ? { id: "cloud-user", email: "u@example.com" }
            : null,
      }),
    );

    it("bridges ?_token into Authorization and ?_workspace into the scope", async () => {
      const res = await makeApp().request(
        `/echo?_token=jwt-123&_workspace=${TARGET_WORKSPACE}`,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ workspaceId: TARGET_WORKSPACE });
    });

    it("rejects when no _token and no session", async () => {
      const res = await makeApp().request(
        `/echo?_workspace=${TARGET_WORKSPACE}`,
      );
      expect(res.status).toBe(401);
    });
  });
});

describe("auth middleware — session-enforcer denial", () => {
  beforeEach(() => {
    initSession({
      getSession: async () => ({
        id: "session-sub-1",
        email: "owner@example.test",
      }),
    });
  });

  afterEach(() => {
    initSessionEnforcer(null);
  });

  it("maps an enforcer denial to an explicit 401 with the reason + code", async () => {
    initSessionEnforcer(async () => ({
      error: "Your organization requires single sign-on.",
      code: "sso_required",
    }));

    const res = await makeApp().request("/echo");
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { message: string; type: string; code?: string };
    };
    expect(body.error.code).toBe("sso_required");
    expect(body.error.message).toContain("single sign-on");
    expect(body.error.type).toBe("authentication_error");
  });

  it("an allowing enforcer authenticates normally", async () => {
    initSessionEnforcer(async () => null);
    const res = await makeApp().request("/echo");
    expect(res.status).toBe(200);
  });
});

describe("auth middleware — role gate", () => {
  const makeAdminApp = () => {
    const app = new Hono<ApiEnv>();
    app.get("/admin", auth({ requireWorkspace: false, role: "admin" }), (c) =>
      c.json({ role: c.get("auth").role ?? null }),
    );
    return app;
  };

  beforeEach(() => {
    initSession({
      getSession: async () => ({
        id: "session-sub-1",
        email: "owner@example.test",
      }),
    });
  });

  afterEach(() => {
    initRoleResolver(null);
    caps.rbac = false;
    membership.active = true;
  });

  it("flat team: a caller with NO active membership never reaches the gate", async () => {
    // The planted negative control for the flat-team arm: skipping the role
    // comparison must never admit an outsider, because org resolution itself
    // (the active-membership fences in resolve.ts) refuses them first — with
    // or without an explicit x-organization-id.
    caps.rbac = false;
    membership.active = false;

    const headerless = await makeAdminApp().request("/admin");
    expect(headerless.status).toBe(401);

    const withHeader = await makeAdminApp().request("/admin", {
      headers: { "x-organization-id": ORG },
    });
    expect(withHeader.status).toBe(401);
  });

  it("flat team: an ORG KEY whose holder left the org is re-fenced at the gate", async () => {
    // API-key principals carry their org from the KEY row, not from a
    // membership-fenced resolution — the role gate's flat-team arm must
    // verify active membership itself or a departed holder's key keeps
    // exercising admin surfaces.
    caps.rbac = false;
    membership.active = false;

    const res = await makeAdminApp().request("/admin", {
      headers: { authorization: "Bearer oc_org_k1" },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        message: "Not a member of this organization",
        type: "authentication_error",
      },
    });
  });

  it("flat team: an ORG KEY with an active holder passes", async () => {
    caps.rbac = false;
    const res = await makeAdminApp().request("/admin", {
      headers: { authorization: "Bearer oc_org_k1" },
    });
    expect(res.status).toBe(200);
  });

  it("flat team (no RBAC): an active member passes admin gates with no resolver", async () => {
    // Membership is proven by org resolution itself (active-membership fences
    // in resolve.ts), so the flat-team arm skips only the role comparison.
    caps.rbac = false;
    const res = await makeAdminApp().request("/admin");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: null });
  });

  it("RBAC with no resolver fails closed (host wiring bug, not flat team)", async () => {
    caps.rbac = true;
    const res = await makeAdminApp().request("/admin");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        message: "Not a member of this organization",
        type: "authentication_error",
      },
    });
  });

  it("RBAC: a member below the threshold is refused", async () => {
    caps.rbac = true;
    initRoleResolver({ getUserRole: async () => "member" });
    const res = await makeAdminApp().request("/admin");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        message: "Insufficient permissions",
        type: "authentication_error",
      },
    });
  });

  it("RBAC: an admin passes and the role lands on the auth context", async () => {
    caps.rbac = true;
    initRoleResolver({ getUserRole: async () => "admin" });
    const res = await makeAdminApp().request("/admin");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "admin" });
  });
});
