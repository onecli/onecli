import { afterEach, describe, expect, it, vi } from "vitest";

// The account-deletion pair on /v1/user answers the PERSON, not a tenant:
//
//   - a session with NO organization at all must reach both (that is the
//     self-host dead end the feature exists for — an org-scoped auth could
//     not even resolve such a session);
//   - an API key — which acts for a workspace or an org — is refused, even
//     a valid one, because a key must never delete the account that owns it;
//   - the edition's session enforcer (enterprise "require SSO") still
//     applies, exactly as on every other session route;
//   - the service's refusal (an owned org with other members) reaches the
//     wire as the documented 409 envelope, not a 500.

const state = vi.hoisted(() => ({
  session: null as { id: string; email: string } | null,
  impacts: [] as unknown[],
  deleted: 0,
}));

vi.mock("@onecli/db", () => ({
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
  db: {
    apiKey: {
      findUnique: async () => ({
        userId: "user-1",
        organizationId: "org-1",
        scope: "organization",
      }),
      findFirst: async () => null,
    },
    user: {
      findUnique: async ({
        where,
      }: {
        where: { externalAuthId?: string; id?: string };
      }) =>
        where.externalAuthId === "ext-1" || where.id === "user-1"
          ? { id: "user-1", email: "person@example.com" }
          : null,
    },
    // The org-less session has no memberships anywhere.
    organizationMember: { findFirst: async () => null },
    // CI's cloud lane injects the enterprise "require SSO" enforcer, which
    // asks whether the session's email domain is enforced; no domain is.
    organizationDomain: { findFirst: async () => null },
  },
}));

vi.mock("../services/account-deletion-service", async () => {
  const { ServiceError } = await import("../services/errors");
  return {
    planAccountDeletion: async () => state.impacts,
    deleteAccount: async () => {
      if (state.impacts.length > 0) {
        throw new ServiceError("CONFLICT", "owned org has other members");
      }
      state.deleted += 1;
    },
  };
});

const { createApiApp } = await import("../app");
const { initSessionEnforcer } = await import("../providers");

const app = createApiApp(
  { getSession: async () => state.session },
  { roleResolver: { getUserRole: async () => "owner" } },
);

const ORG_KEY = { Authorization: "Bearer oc_org_test-key" };

afterEach(() => {
  state.session = null;
  state.impacts = [];
  state.deleted = 0;
  initSessionEnforcer(null);
});

describe("GET /v1/user/deletion-impact", () => {
  it("answers an org-less session", async () => {
    state.session = { id: "ext-1", email: "person@example.com" };
    state.impacts = [{ organizationId: "o1", outcome: "leave" }];
    const res = await app.request("/v1/user/deletion-impact");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      organizations: [{ organizationId: "o1", outcome: "leave" }],
    });
  });

  it("refuses a valid API key", async () => {
    const res = await app.request("/v1/user/deletion-impact", {
      headers: ORG_KEY,
    });
    expect(res.status).toBe(401);
  });

  it("401s with no session", async () => {
    const res = await app.request("/v1/user/deletion-impact");
    expect(res.status).toBe(401);
  });

  it("honors the edition's session enforcer", async () => {
    state.session = { id: "ext-1", email: "person@example.com" };
    initSessionEnforcer(async () => ({
      error: "SSO required",
      code: "sso_required",
    }));
    const res = await app.request("/v1/user/deletion-impact");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: { code: "sso_required", message: "SSO required" },
    });
  });
});

describe("DELETE /v1/user", () => {
  it("deletes the account of an org-less session with 204", async () => {
    state.session = { id: "ext-1", email: "person@example.com" };
    const res = await app.request("/v1/user", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(state.deleted).toBe(1);
  });

  it("surfaces the service's refusal as the 409 envelope", async () => {
    state.session = { id: "ext-1", email: "person@example.com" };
    state.impacts = [{ organizationId: "o1", outcome: "blocked" }];
    const res = await app.request("/v1/user", { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        message: "owned org has other members",
        type: "invalid_request_error",
      },
    });
    expect(state.deleted).toBe(0);
  });

  it("refuses a valid API key without touching the account", async () => {
    const res = await app.request("/v1/user", {
      method: "DELETE",
      headers: ORG_KEY,
    });
    expect(res.status).toBe(401);
    expect(state.deleted).toBe(0);
  });

  it("keeps the identity routes on the org-scoped auth (an org key still reads GET /user)", async () => {
    const res = await app.request("/v1/user", { headers: ORG_KEY });
    expect(res.status).toBe(200);
  });
});
