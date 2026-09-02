import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../types";

// The rename-compat layer must keep OLD released clients working against the
// renamed server without weakening any fence. Top-priority surface: an org
// key (`oc_org_`) scoping with the legacy X-Project-Id header. Everything
// here runs through the REAL app (`createApiApp`) so the middleware order,
// the auth bridge, and the alias re-dispatch are the production paths.
//
// Delete this file together with `legacy-project-compat.ts` at sunset.

const ORG = "org-1";
const WORKSPACE = "ws-1";
const OUTSIDE_WORKSPACE = "ws-outside-org";
const ORG_KEY = "oc_org_test-key";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = "test-secret";
  process.env.OAUTH_STATE_SECRET = "test-secret";
});

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
      findMany: async () => [{ organization: { id: ORG, name: "Org One" } }],
    },
    workspace: {
      // The org fence: only WORKSPACE exists inside ORG — any other id
      // resolves to null exactly like a foreign org's workspace would.
      findFirst: async ({ where }: { where?: { id?: string } }) =>
        where?.id
          ? where.id === WORKSPACE
            ? { id: where.id, organizationId: ORG, createdByUserId: "user-1" }
            : null
          : { id: WORKSPACE, organizationId: ORG },
      findUnique: async () => ({ organizationId: ORG }),
      findMany: async () => [
        { id: WORKSPACE, name: "Workspace One", organizationId: ORG },
      ],
    },
    agent: { findMany: async () => [], findFirst: async () => null },
    requestLog: { groupBy: async () => [] },
    appConnection: { findMany: async () => [], findFirst: async () => null },
    secret: { findMany: async () => [] },
    policyRuleV2: {
      findMany: async () => [],
      aggregate: async () => ({ _max: { generation: null } }),
    },
    auditLog: { create: async () => ({}) },
  },
}));

let app: Hono<ApiEnv>;

beforeAll(async () => {
  const { createApiApp } = await import("../app");
  const { auth } = await import("../middleware/auth");
  // Session only when a test opts in via marker header — Bearer-key tests
  // must stay anonymous on the session path (strict key auth commits first).
  app = createApiApp({
    getSession: async (request: Request) =>
      request.headers.get("x-test-session")
        ? { id: "ext-user-1", email: "admin@example.com" }
        : null,
  });
  // Echoes the workspace the REAL middleware chain resolved (compat bridge →
  // auth bridge → org-key resolver → org fence).
  app.get("/echo-auth", auth(), (c) =>
    c.json({ workspaceId: c.get("auth").workspaceId }),
  );
  // The real-app import graph takes ~10s cold — vitest's default hookTimeout.
}, 30_000);

const orgKey = { Authorization: `Bearer ${ORG_KEY}` };

describe("org-key legacy scope inputs (the top-priority surface)", () => {
  it("X-Project-Id scopes an org key exactly like X-Workspace-Id", async () => {
    const res = await app.request("/v1/echo-auth", {
      headers: { ...orgKey, "X-Project-Id": WORKSPACE },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaceId: WORKSPACE });
    expect(res.headers.get("Deprecation")).toBe("true");
    expect(res.headers.get("Link")).toContain('rel="deprecation"');
  });

  it("a canonical header always wins over a conflicting legacy header", async () => {
    // OUTSIDE_WORKSPACE fails the org fence — if the legacy header could
    // override, this request would 401 instead of resolving WORKSPACE.
    const res = await app.request("/v1/echo-auth", {
      headers: {
        ...orgKey,
        "X-Workspace-Id": WORKSPACE,
        "X-Project-Id": OUTSIDE_WORKSPACE,
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaceId: WORKSPACE });
    expect(res.headers.get("Deprecation")).toBeNull();
  });

  it("the org fence rejects a legacy header naming a workspace outside the key's org", async () => {
    const res = await app.request("/v1/echo-auth", {
      headers: { ...orgKey, "X-Project-Id": OUTSIDE_WORKSPACE },
    });
    expect(res.status).toBe(401);
  });

  it("an org key with no scope input still 401s, naming both header generations", async () => {
    const res = await app.request("/v1/echo-auth", { headers: orgKey });
    expect(res.status).toBe(401);
    const body = await res.json();
    // The old CLI string-matches "X-Project-Id" to print its scoping hint;
    // the new name leads for current clients.
    expect(body.error.message).toBe(
      "X-Workspace-Id (formerly X-Project-Id) header is required",
    );
  });

  it("?_project bridges into the workspace scope", async () => {
    const res = await app.request(`/v1/echo-auth?_project=${WORKSPACE}`, {
      headers: orgKey,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaceId: WORKSPACE });
    expect(res.headers.get("Deprecation")).toBe("true");
  });

  it("?_workspace wins over both legacy inputs", async () => {
    const res = await app.request(
      `/v1/echo-auth?_workspace=${WORKSPACE}&_project=${OUTSIDE_WORKSPACE}`,
      { headers: { ...orgKey, "X-Project-Id": OUTSIDE_WORKSPACE } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaceId: WORKSPACE });
    expect(res.headers.get("Deprecation")).toBeNull();
  });

  it("a non-Latin-1 legacy value degrades to absent, never a 500", async () => {
    const res = await app.request("/v1/echo-auth?_project=%F0%9F%92%A5", {
      headers: orgKey,
    });
    expect(res.status).toBe(401);
  });
});

describe("the /v1/projects alias answers byte-identically to /v1/workspaces", () => {
  const scoped = {
    headers: { ...orgKey, "X-Workspace-Id": WORKSPACE },
  };

  const pair = async (method: string, legacy: string, canonical: string) => {
    const [fromAlias, fromCanonical] = await Promise.all([
      app.request(legacy, { method, ...scoped }),
      app.request(canonical, { method, ...scoped }),
    ]);
    return { fromAlias, fromCanonical };
  };

  it.each([
    ["GET", "/v1/projects", "/v1/workspaces"],
    ["GET", `/v1/projects/${WORKSPACE}`, `/v1/workspaces/${WORKSPACE}`],
    [
      "GET",
      `/v1/projects/${WORKSPACE}/access`,
      `/v1/workspaces/${WORKSPACE}/access`,
    ],
    [
      "GET",
      "/v1/projects/nope/no-such-endpoint",
      "/v1/workspaces/nope/no-such-endpoint",
    ],
  ])("%s %s mirrors %s", async (method, legacy, canonical) => {
    const { fromAlias, fromCanonical } = await pair(method, legacy, canonical);
    expect(fromAlias.status).toBe(fromCanonical.status);
    expect(await fromAlias.text()).toBe(await fromCanonical.text());
  });

  it("reaches the EE access surface through the alias (never the router's 404)", async () => {
    const res = await app.request(`/v1/projects/${WORKSPACE}/access`, scoped);
    expect(res.status).not.toBe(404);
  });

  it("marks every aliased response deprecated", async () => {
    const res = await app.request("/v1/projects", scoped);
    expect(res.headers.get("Deprecation")).toBe("true");
  });

  it("preserves method, body, and query through the re-dispatch", async () => {
    // A minimal app around the real install function — on the full app an
    // artificial echo route under /workspaces would be intercepted by the EE
    // access router's entitlement gate, which real routes (registered ahead
    // of it) never hit.
    const { Hono } = await import("hono");
    const { installLegacyProjectCompat } =
      await import("./legacy-project-compat");
    const mini = new Hono<ApiEnv>().basePath("/v1");
    installLegacyProjectCompat(mini);
    mini.post("/workspaces/echo-body", async (c) =>
      c.json({ body: await c.req.json(), q: c.req.query("q") }),
    );
    // Registered up front — Hono freezes its matcher on first dispatch.
    mini.post("/workspaces/echo-bridged", async (c) =>
      c.json({
        body: await c.req.json(),
        bridged: c.req.header("x-workspace-id"),
      }),
    );

    const res = await mini.request("/v1/projects/echo-body?q=kept", {
      method: "POST",
      body: JSON.stringify({ name: "hello", nested: { keep: true } }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      body: { name: "hello", nested: { keep: true } },
      q: "kept",
    });

    // The header bridge reassigns `c.req.raw` — the body must survive that
    // clone too (route handlers read it through the reassigned request).
    const bridged = await mini.request("/v1/workspaces/echo-bridged", {
      method: "POST",
      body: JSON.stringify({ survives: "the-reassign" }),
      headers: { "Content-Type": "application/json", "X-Project-Id": "ws-9" },
    });
    expect(bridged.status).toBe(200);
    expect(await bridged.json()).toEqual({
      body: { survives: "the-reassign" },
      bridged: "ws-9",
    });
  });

  it("does not alias mere prefix look-alikes", async () => {
    const res = await app.request("/v1/projectsx", scoped);
    expect(res.status).toBe(404);
    expect(res.headers.get("Deprecation")).toBeNull();
  });
});

describe('policy-rule bodies accept the legacy scope literal "project"', () => {
  it('stores connectionScope "project" as workspace', async () => {
    const { createPolicyRuleSchema } = await import("../validations/policy");
    const parsed = createPolicyRuleSchema.safeParse({
      name: "compat rule",
      action: "allow",
      targets: [
        { kind: "app", provider: "github", connectionScope: "project" },
      ],
    });
    expect(parsed.success).toBe(true);
    const target = parsed.success ? parsed.data.targets?.[0] : undefined;
    expect(target?.kind === "app" ? target.connectionScope : undefined).toBe(
      "workspace",
    );
  });

  it('stores secretScope "project" as workspace', async () => {
    const { createPolicyRuleSchema } = await import("../validations/policy");
    const parsed = createPolicyRuleSchema.safeParse({
      name: "compat rule",
      action: "allow",
      targets: [{ kind: "secret", secretScope: "project" }],
    });
    expect(parsed.success).toBe(true);
    const target = parsed.success ? parsed.data.targets?.[0] : undefined;
    expect(target?.kind === "secret" ? target.secretScope : undefined).toBe(
      "workspace",
    );
  });

  it("still rejects an unknown scope literal", async () => {
    const { createPolicyRuleSchema } = await import("../validations/policy");
    const parsed = createPolicyRuleSchema.safeParse({
      name: "bad rule",
      action: "allow",
      targets: [{ kind: "secret", secretScope: "banana" }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("dual-emit helpers", () => {
  it("withLegacyProjectId mirrors workspaceId into projectId", async () => {
    const { withLegacyProjectId } = await import("./legacy-project-compat");
    expect(withLegacyProjectId({ workspaceId: WORKSPACE, other: 1 })).toEqual({
      workspaceId: WORKSPACE,
      projectId: WORKSPACE,
      other: 1,
    });
  });

  it("withLegacyProjectId leaves payloads without a workspace untouched", async () => {
    const { withLegacyProjectId } = await import("./legacy-project-compat");
    expect(withLegacyProjectId({ other: 1 })).toEqual({ other: 1 });
    expect(withLegacyProjectId({ workspaceId: 7 })).toEqual({ workspaceId: 7 });
  });

  it("withLegacyProjectLists mirrors workspaces into projects", async () => {
    const { withLegacyProjectLists } = await import("./legacy-project-compat");
    const orgs = [{ id: ORG, workspaces: [{ id: WORKSPACE, name: "W" }] }];
    expect(withLegacyProjectLists(orgs)[0]).toEqual({
      id: ORG,
      workspaces: [{ id: WORKSPACE, name: "W" }],
      projects: [{ id: WORKSPACE, name: "W" }],
    });
  });

  it("GET /v1/auth/cli/options dual-emits projects beside workspaces", async () => {
    const res = await app.request("/v1/auth/cli/options", {
      headers: { "x-test-session": "user" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.organizations).toHaveLength(1);
    expect(body.organizations[0].projects).toEqual(
      body.organizations[0].workspaces,
    );
    expect(body.organizations[0].workspaces).toEqual([
      { id: WORKSPACE, name: "Workspace One" },
    ]);
  });
});
