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
import { ServiceError } from "../../services/errors";
import { errorHandler } from "../../middleware/error-handler";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: unknown[] }>,
  audits: [] as Record<string, unknown>[],
  row: { userId: "user-t", status: "active", ssoExempt: false } as Record<
    string,
    unknown
  >,
  suspendError: null as Error | null,
  featureAllowed: true,
  provisionCreated: true,
  memberLookup: null as Record<string, unknown> | null,
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

vi.mock("../services/team-service", () => ({
  suspendMember: async (...args: unknown[]) => {
    if (state.suspendError) throw state.suspendError;
    state.calls.push({ fn: "suspendMember", args });
    return "disabled";
  },
  reinstateMember: async (...args: unknown[]) => {
    state.calls.push({ fn: "reinstateMember", args });
    return "enabled";
  },
  setMemberSsoExempt: async (...args: unknown[]) => {
    state.calls.push({ fn: "setMemberSsoExempt", args });
  },
  listMembersPage: async (...args: unknown[]) => {
    state.calls.push({ fn: "listMembersPage", args });
    return {
      data: [{ userId: "user-t", email: "t@acme.com" }],
      nextCursor: null,
    };
  },
  removeMember: async (...args: unknown[]) => {
    state.calls.push({ fn: "removeMember", args });
    return "disabled";
  },
}));

vi.mock("../services/org-directory-service", () => ({
  provisionMember: async (...args: unknown[]) => {
    state.calls.push({ fn: "provisionMember", args });
    return {
      userId: "user-new",
      email: args[1],
      name: args[2],
      role: "member",
      status: "active",
      joinedAt: new Date("2026-01-01"),
      created: state.provisionCreated,
      userCreated: state.provisionCreated,
    };
  },
  findMemberByUserId: async (...args: unknown[]) => {
    state.calls.push({ fn: "findMemberByUserId", args });
    return state.memberLookup;
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

vi.mock("../services/group-service", () => ({
  listGroupsForUser: async (...args: unknown[]) => {
    state.calls.push({ fn: "listGroupsForUser", args });
    return { data: [], nextCursor: null };
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
    organizationMember: {
      findUniqueOrThrow: async () => state.row,
    },
  },
}));

import { orgMemberRoutes } from "./org-members";

const app = new Hono<ApiEnv>()
  .route("/org/members", orgMemberRoutes())
  .onError(errorHandler);

const patch = (userId: string, body: unknown) =>
  app.request(`/org/members/${userId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  state.calls = [];
  state.audits = [];
  state.row = { userId: "user-t", status: "active", ssoExempt: false };
  state.suspendError = null;
  state.featureAllowed = true;
  state.provisionCreated = true;
  state.memberLookup = null;
});

// This suite exercises licensed features — run it entitled. The unlicensed
// refusal of each feature is proven in licensing/enterprise-lock.test.ts.
beforeAll(() => initEntitlementForTests(true));
afterAll(() => initEntitlementForTests(null));

describe("PATCH /org/members/:userId", () => {
  it("suspends: dispatches with the acting user + audits UPDATE/MEMBER with the revocation outcome", async () => {
    state.row = { userId: "user-t", status: "suspended", ssoExempt: false };
    const res = await patch("user-t", { status: "suspended" });
    expect(res.status).toBe(200);
    expect(state.calls[0]).toEqual({
      fn: "suspendMember",
      args: ["org-1", "user-t", "admin-1"],
    });
    expect(state.audits[0]).toMatchObject({
      action: "update",
      service: "member",
      metadata: {
        targetUserId: "user-t",
        status: "suspended",
        revocation: "disabled",
      },
    });
    await expect(res.json()).resolves.toMatchObject({
      userId: "user-t",
      status: "suspended",
      revocation: "disabled",
    });
  });

  it("reinstates", async () => {
    const res = await patch("user-t", { status: "active" });
    expect(res.status).toBe(200);
    expect(state.calls[0]).toEqual({
      fn: "reinstateMember",
      args: ["org-1", "user-t"],
    });
  });

  it("flips the SSO exemption", async () => {
    state.row = { userId: "user-t", status: "active", ssoExempt: true };
    const res = await patch("user-t", { ssoExempt: true });
    expect(res.status).toBe(200);
    expect(state.calls[0]).toEqual({
      fn: "setMemberSsoExempt",
      args: ["org-1", "user-t", true],
    });
    expect(state.audits[0]).toMatchObject({
      metadata: { targetUserId: "user-t", ssoExempt: true },
    });
  });

  it("rejects both changes at once and unknown shapes", async () => {
    expect(
      (await patch("user-t", { status: "active", ssoExempt: true })).status,
    ).toBe(400);
    expect((await patch("user-t", { status: "deleted" })).status).toBe(400);
    expect((await patch("user-t", {})).status).toBe(400);
    expect(state.calls).toHaveLength(0);
  });

  it("maps service guards to their statuses (owner suspension → 400)", async () => {
    state.suspendError = new ServiceError(
      "BAD_REQUEST",
      "The organization owner cannot be suspended",
    );
    const res = await patch("owner-1", { status: "suspended" });
    expect(res.status).toBe(400);
    expect(state.audits).toHaveLength(0);
  });
});

describe("GET /org/members (directory read)", () => {
  it("dispatches with the parsed query and returns the envelope", async () => {
    const res = await app.request("/org/members?limit=10&q=ali&status=active");
    expect(res.status).toBe(200);
    expect(state.calls[0]).toEqual({
      fn: "listMembersPage",
      args: ["org-1", { limit: 10, q: "ali", status: "active" }],
    });
    await expect(res.json()).resolves.toMatchObject({ nextCursor: null });
  });

  it("400s on an unknown status filter", async () => {
    const res = await app.request("/org/members?status=deleted");
    expect(res.status).toBe(400);
    expect(state.calls).toHaveLength(0);
  });
});

describe("GET /org/members/:userId/groups (reverse lookup)", () => {
  it("dispatches org-scoped", async () => {
    const res = await app.request("/org/members/user-t/groups");
    expect(res.status).toBe(200);
    expect(state.calls[0]).toEqual({
      fn: "listGroupsForUser",
      args: ["org-1", "user-t", {}],
    });
  });
});

describe("POST /org/members (first-party provisioning — the SCIM twin)", () => {
  const post = (body: unknown) =>
    app.request("/org/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("provisions through the directory core and audits CREATE/MEMBER", async () => {
    const res = await post({ email: "New@Acme.com", name: "New Person" });
    expect(res.status).toBe(201);
    // zod normalized the email before the service saw it
    expect(state.calls[0]).toEqual({
      fn: "provisionMember",
      args: ["org-1", "new@acme.com", "New Person"],
    });
    expect(state.audits[0]).toMatchObject({
      action: "create",
      service: "member",
      metadata: { targetUserId: "user-new", email: "new@acme.com" },
    });
    await expect(res.json()).resolves.toMatchObject({
      userId: "user-new",
      role: "member",
      status: "active",
    });
  });

  it("existing membership → 409, no audit", async () => {
    state.provisionCreated = false;
    const res = await post({ email: "old@acme.com" });
    expect(res.status).toBe(409);
    expect(state.audits).toHaveLength(0);
  });

  it("is Enterprise-gated (sso)", async () => {
    state.featureAllowed = false;
    const res = await post({ email: "new@acme.com" });
    expect(res.status).toBe(403);
    expect(
      state.calls.filter((call) => call.fn === "provisionMember"),
    ).toHaveLength(0);
  });

  it("rejects invalid emails and unknown keys", async () => {
    expect((await post({ email: "not-an-email" })).status).toBe(400);
    expect((await post({ email: "a@x.com", role: "admin" })).status).toBe(400);
    expect(
      state.calls.filter((call) => call.fn === "provisionMember"),
    ).toHaveLength(0);
  });
});

describe("DELETE /org/members/:userId (hard offboarding)", () => {
  const del = (userId: string) =>
    app.request(`/org/members/${userId}`, { method: "DELETE" });

  it("removes after the typed pre-checks and audits DELETE/MEMBER", async () => {
    state.memberLookup = {
      userId: "user-t",
      email: "t@acme.com",
      role: "member",
    };
    const res = await del("user-t");
    expect(res.status).toBe(204);
    expect(state.calls).toEqual([
      { fn: "findMemberByUserId", args: ["org-1", "user-t"] },
      { fn: "removeMember", args: ["org-1", "user-t"] },
    ]);
    expect(state.audits[0]).toMatchObject({
      action: "delete",
      service: "member",
      metadata: { targetUserId: "user-t", revocation: "disabled" },
    });
  });

  it("unknown member → 404 (typed, not a plain-Error 500)", async () => {
    const res = await del("ghost");
    expect(res.status).toBe(404);
    expect(
      state.calls.filter((call) => call.fn === "removeMember"),
    ).toHaveLength(0);
  });

  it("owner → 400 before the destructive path runs", async () => {
    state.memberLookup = {
      userId: "owner-1",
      email: "own@acme.com",
      role: "owner",
    };
    const res = await del("owner-1");
    expect(res.status).toBe(400);
    expect(
      state.calls.filter((call) => call.fn === "removeMember"),
    ).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });
});
