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

const state = vi.hoisted(() => ({
  ssoRequired: false,
  activeConnection: null as { id: string } | null,
  verifiedDomain: null as { id: string } | null,
  exemptCount: 0,
  orgUpdates: [] as Record<string, unknown>[],
  featureChecks: [] as string[],
  audits: [] as Record<string, unknown>[],
}));

vi.mock("../../middleware/auth", () => ({
  auth: (): MiddlewareHandler<ApiEnv> => async (c, next) => {
    c.set("auth", {
      userId: "admin-1",
      userEmail: "admin@acme.com",
      organizationId: "org-1",
    });
    await next();
  },
}));

vi.mock("../services/quota-service", () => ({
  assertFeatureAllowed: async (_orgId: string, feature: string) => {
    state.featureChecks.push(feature);
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

vi.mock("@onecli/db", () => ({
  db: {
    organization: {
      findUniqueOrThrow: async () => ({ ssoRequired: state.ssoRequired }),
      update: async (args: Record<string, unknown>) => {
        state.orgUpdates.push(args);
        return { id: "org-1" };
      },
    },
    organizationSsoConnection: {
      findFirst: async () => state.activeConnection,
    },
    organizationDomain: {
      findFirst: async () => state.verifiedDomain,
    },
    organizationMember: {
      count: async () => state.exemptCount,
    },
  },
}));

import { orgSsoEnforcementRoutes } from "./org-sso-enforcement";

const app = new Hono<ApiEnv>().route(
  "/org/sso/enforcement",
  orgSsoEnforcementRoutes(),
);

const patch = (body: unknown) =>
  app.request("/org/sso/enforcement", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  state.ssoRequired = false;
  state.activeConnection = null;
  state.verifiedDomain = null;
  state.exemptCount = 0;
  state.orgUpdates = [];
  state.featureChecks = [];
  state.audits = [];
});

// This suite exercises licensed features — run it entitled. The unlicensed
// refusal of each feature is proven in licensing/enterprise-lock.test.ts.
beforeAll(() => initEntitlementForTests(true));
afterAll(() => initEntitlementForTests(null));

describe("GET /org/sso/enforcement", () => {
  it("returns the full enforcement state", async () => {
    state.activeConnection = { id: "conn-1" };
    state.exemptCount = 2;
    const res = await app.request("/org/sso/enforcement");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ssoRequired: false,
      hasActiveConnection: true,
      hasVerifiedDomain: false,
      canRequire: false,
      exemptMemberCount: 2,
    });
  });
});

describe("PATCH /org/sso/enforcement", () => {
  it("refuses enabling without the preconditions, naming the missing leg", async () => {
    state.verifiedDomain = { id: "dom-1" };
    const res = await patch({ ssoRequired: true });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("active SSO connection");
    expect(state.orgUpdates).toHaveLength(0);
  });

  it("enables when both preconditions hold — plan-gated + audited", async () => {
    state.activeConnection = { id: "conn-1" };
    state.verifiedDomain = { id: "dom-1" };
    const res = await patch({ ssoRequired: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ssoRequired: boolean };
    expect(body.ssoRequired).toBe(true);
    expect(state.featureChecks).toEqual(["sso"]);
    expect(state.orgUpdates[0]).toMatchObject({
      data: { ssoRequired: true },
    });
    expect(state.audits[0]).toMatchObject({
      metadata: { ssoRequired: true },
    });
  });

  it("disabling is never plan-gated or precondition-gated", async () => {
    state.ssoRequired = true;
    const res = await patch({ ssoRequired: false });
    expect(res.status).toBe(200);
    expect(state.featureChecks).toHaveLength(0);
    expect(state.orgUpdates[0]).toMatchObject({
      data: { ssoRequired: false },
    });
  });

  it("no-op writes neither update nor audit", async () => {
    const res = await patch({ ssoRequired: false });
    expect(res.status).toBe(200);
    expect(state.orgUpdates).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it("rejects malformed bodies", async () => {
    expect((await patch({})).status).toBe(400);
    expect((await patch({ ssoRequired: "yes" })).status).toBe(400);
  });
});
