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

// Token management over the real routes with the service mocked: show-once
// plaintext on create only, the enterprise gate on create (revoke stays
// ungated — cutting off an integration must never hide behind a plan
// check), soft revoke, and audit dispatch that never carries the token.

const state = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: unknown[] }>,
  audits: [] as Record<string, unknown>[],
  featureAllowed: true,
  revokeError: null as Error | null,
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
  assertFeatureAllowed: async () => {
    if (!state.featureAllowed) {
      const { ServiceError } = await import("../../services/errors");
      throw new ServiceError("FORBIDDEN", "Requires the Enterprise plan");
    }
  },
}));

vi.mock("../services/scim-token-service", () => ({
  listScimTokens: async (...args: unknown[]) => {
    state.calls.push({ fn: "listScimTokens", args });
    return [
      {
        id: "tok-1",
        label: "Okta",
        lastUsedAt: null,
        createdAt: new Date("2026-01-01"),
      },
    ];
  },
  createScimToken: async (...args: unknown[]) => {
    state.calls.push({ fn: "createScimToken", args });
    return {
      id: "tok-2",
      label: args[1],
      lastUsedAt: null,
      createdAt: new Date("2026-01-02"),
      token: "oc_scim_" + "d".repeat(48),
    };
  },
  revokeScimToken: async (...args: unknown[]) => {
    if (state.revokeError) throw state.revokeError;
    state.calls.push({ fn: "revokeScimToken", args });
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

import { orgScimTokenRoutes } from "./org-scim-tokens";

const app = new Hono<ApiEnv>()
  .route("/org/scim/tokens", orgScimTokenRoutes())
  .onError(errorHandler);

beforeEach(() => {
  state.calls = [];
  state.audits = [];
  state.featureAllowed = true;
  state.revokeError = null;
});

// This suite exercises licensed features — run it entitled. The unlicensed
// refusal of each feature is proven in licensing/enterprise-lock.test.ts.
beforeAll(() => initEntitlementForTests(true));
afterAll(() => initEntitlementForTests(null));

describe("GET /org/scim/tokens", () => {
  it("lists non-revoked tokens (readable without the plan gate)", async () => {
    state.featureAllowed = false;
    const res = await app.request("/org/scim/tokens");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>[];
    expect(body[0]).toMatchObject({ id: "tok-1", label: "Okta" });
    expect(JSON.stringify(body)).not.toContain("oc_scim_");
  });
});

describe("POST /org/scim/tokens", () => {
  const post = (body: unknown) =>
    app.request("/org/scim/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("creates with a show-once plaintext + audits without the token", async () => {
    const res = await post({ label: "Entra" });
    expect(res.status).toBe(201);
    expect(state.calls[0]).toEqual({
      fn: "createScimToken",
      args: ["org-1", "Entra", "admin-1"],
    });
    await expect(res.json()).resolves.toMatchObject({
      id: "tok-2",
      token: "oc_scim_" + "d".repeat(48),
    });
    expect(state.audits[0]).toMatchObject({
      action: "create",
      service: "scim-token",
      metadata: { tokenId: "tok-2", label: "Entra" },
    });
    // the audit must never carry the plaintext
    expect(JSON.stringify(state.audits)).not.toContain("oc_scim_");
  });

  it("is Enterprise-gated (sso)", async () => {
    state.featureAllowed = false;
    const res = await post({ label: "Entra" });
    expect(res.status).toBe(403);
    expect(state.calls).toHaveLength(0);
  });

  it("rejects missing/blank/oversized labels", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ label: "  " })).status).toBe(400);
    expect((await post({ label: "x".repeat(65) })).status).toBe(400);
    expect(state.calls).toHaveLength(0);
  });
});

describe("DELETE /org/scim/tokens/:tokenId", () => {
  it("soft-revokes WITHOUT the plan gate and audits", async () => {
    state.featureAllowed = false; // lapsed plan must still be able to revoke
    const res = await app.request("/org/scim/tokens/tok-1", {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(state.calls[0]).toEqual({
      fn: "revokeScimToken",
      args: ["org-1", "tok-1"],
    });
    expect(state.audits[0]).toMatchObject({
      action: "delete",
      service: "scim-token",
      metadata: { tokenId: "tok-1" },
    });
  });

  it("maps a cross-org/unknown token to 404", async () => {
    const { ServiceError } = await import("../../services/errors");
    state.revokeError = new ServiceError("NOT_FOUND", "SCIM token not found");
    const res = await app.request("/org/scim/tokens/foreign", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    expect(state.audits).toHaveLength(0);
  });
});
