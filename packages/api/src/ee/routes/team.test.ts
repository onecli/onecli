import { Hono } from "hono";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
  beforeAll,
  afterAll,
} from "vitest";
import { initEntitlementForTests } from "../../lib/entitlements";
import type { ApiEnv } from "../../types";
import type { MiddlewareHandler } from "hono";
import { errorHandler } from "../../middleware/error-handler";

// POST /v1/team/provisions is a PUBLISHED wire contract (node-sdk
// `provisionProject`, docs guides/user-provisioning.mdx + openapi.yaml) that
// predates the project→workspace rename. This suite locks the parts a green
// refactor could silently break: the `projectId` response field, the
// admin-role gate, the SDK's `{}`/absent-body leniency, and the audit row
// carrying neither the token nor the API key.

const state = vi.hoisted(() => ({
  authOptions: null as Record<string, unknown> | null,
  provisionArgs: null as Record<string, unknown> | null,
  audits: [] as Record<string, unknown>[],
}));

vi.mock("../../middleware/auth", () => ({
  auth:
    (options?: Record<string, unknown>): MiddlewareHandler<ApiEnv> =>
    async (c, next) => {
      state.authOptions = options ?? null;
      c.set("auth", {
        userId: "admin-1",
        userEmail: "admin@acme.com",
        organizationId: "org-1",
      });
      await next();
    },
}));

vi.mock("../services/user-provision-service", () => ({
  provisionUser: async (params: Record<string, unknown>) => {
    state.provisionArgs = params;
    return {
      id: "prov-1",
      userId: "placeholder-1",
      workspaceId: "ws-1",
      apiKey: "oc_test_key",
      claimUrl: "http://localhost:3000/claim?token=tok-1",
      expiresAt: new Date("2026-08-18T00:00:00Z"),
    };
  },
}));

vi.mock("../../services/audit-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/audit-service")>();
  return {
    ...actual,
    withAudit: async (
      op: () => Promise<unknown>,
      params: (r: unknown) => Record<string, unknown>,
    ) => {
      const result = await op();
      state.audits.push(params(result));
      return result;
    },
  };
});

import { teamRoutes } from "./team";

const app = new Hono<ApiEnv>()
  .route("/team", teamRoutes())
  .onError(errorHandler);

const mint = (body?: BodyInit) =>
  app.request("/team/provisions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

beforeEach(() => {
  state.authOptions = null;
  state.provisionArgs = null;
  state.audits = [];
});

// This suite exercises a licensed feature — run it entitled. The unlicensed
// 403 is proven by licensing/enterprise-lock.test.ts.
beforeAll(() => initEntitlementForTests(true));
afterAll(() => initEntitlementForTests(null));

describe("POST /team/provisions", () => {
  it("answers 201 with the published wire shape — projectId, not workspaceId", async () => {
    const res = await mint(JSON.stringify({ role: "admin" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;

    // The exact published field set: renaming projectId (or leaking new
    // fields the SDK's types don't know) is the regression this pins.
    expect(Object.keys(body).sort()).toEqual([
      "apiKey",
      "claimUrl",
      "expiresAt",
      "id",
      "projectId",
      "userId",
    ]);
    expect(body.projectId).toBe("ws-1");
    expect(body.apiKey).toBe("oc_test_key");

    expect(state.provisionArgs).toMatchObject({
      organizationId: "org-1",
      role: "admin",
      provisionedById: "admin-1",
      provisionedByEmail: "admin@acme.com",
    });
  });

  it("requires the org-admin gate on the router", async () => {
    await mint(JSON.stringify({}));
    // Dropping role:"admin" would let any member mint placeholder accounts
    // (and admin-role ones at that) — the option itself is the boundary.
    expect(state.authOptions).toMatchObject({
      requireWorkspace: false,
      role: "admin",
    });
  });

  it("keeps the SDK's leniency: `{}` and malformed bodies mint with defaults", async () => {
    const empty = await mint(JSON.stringify({}));
    expect(empty.status).toBe(201);
    expect(state.provisionArgs).toMatchObject({
      role: "member",
      skipOnboarding: true,
    });

    const malformed = await mint("this is not json");
    expect(malformed.status).toBe(201);
  });

  it("refuses an unknown role with 400", async () => {
    const res = await mint(JSON.stringify({ role: "owner" }));
    expect(res.status).toBe(400);
    expect(state.provisionArgs).toBeNull();
  });

  it("audits the mint without ever recording the token, claim URL, or key", async () => {
    await mint(JSON.stringify({}));
    expect(state.audits).toHaveLength(1);
    const audit = state.audits[0]!;
    expect(audit).toMatchObject({
      organizationId: "org-1",
      userId: "admin-1",
      action: "create",
      service: "provision",
      source: "api",
    });
    const serialized = JSON.stringify(audit.metadata);
    expect(serialized).not.toContain("tok-1");
    expect(serialized).not.toContain("oc_test_key");
    expect(serialized).not.toContain("claim?token");
  });
});
