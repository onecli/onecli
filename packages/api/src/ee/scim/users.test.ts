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

// /scim/v2/Users over the REAL scim app (auth → rate limit → routes →
// error mapping) with the directory service mocked: the auth matrix incl.
// revoked tokens and cross-org isolation, the Entra Test Connection probe,
// recorded PatchOp quirks (capitalized ops, boolean strings), the owner-
// deactivate 400, uniqueness 409 shape, pagination, and the scim+json
// content type on every response.

interface MockMember {
  organizationId: string;
  userId: string;
  email: string;
  name: string | null;
  nameComponents: Record<string, unknown> | null;
  role: string;
  status: string;
  ssoExempt: boolean;
  joinedAt: Date;
  lastModifiedAt: Date;
}

const state = vi.hoisted(() => ({
  tokens: [] as {
    hash: string;
    id: string;
    organizationId: string;
    label: string;
    revokedAt: Date | null;
  }[],
  tokenUpdates: [] as { id: string }[],
  members: [] as MockMember[],
  calls: {
    deactivate: [] as unknown[][],
    reactivate: [] as unknown[][],
    updateName: [] as unknown[][],
    provision: [] as unknown[][],
    rename: [] as unknown[][],
  },
  deactivateError: null as Error | null,
  renameError: null as Error | null,
  rateCount: 0,
  audits: [] as { action: string; service: string; metadata: unknown }[],
}));

vi.mock("@onecli/db", () => ({
  db: {
    organizationScimToken: {
      findUnique: async ({
        where,
        select,
      }: {
        where: { tokenHash: string };
        select: Record<string, true>;
      }) => {
        void select;
        const token = state.tokens.find((t) => t.hash === where.tokenHash);
        return token
          ? {
              id: token.id,
              organizationId: token.organizationId,
              label: token.label,
              revokedAt: token.revokedAt,
            }
          : null;
      },
      update: async ({ where }: { where: { id: string } }) => {
        state.tokenUpdates.push(where);
        return {};
      },
    },
  },
}));

vi.mock("../clients/redis-client", () => ({
  hasRedisConfigured: () => true,
  getRedis: () => ({
    incr: async () => ++state.rateCount,
    expire: async () => 1,
  }),
}));

vi.mock("./audit", () => ({
  scimAudit: async (
    _scim: unknown,
    action: string,
    service: string,
    metadata: unknown,
  ) => {
    state.audits.push({ action, service, metadata });
  },
}));

vi.mock("../services/org-directory-service", () => ({
  findMemberByUserId: async (organizationId: string, userId: string) =>
    state.members.find(
      (m) => m.organizationId === organizationId && m.userId === userId,
    ) ?? null,
  findMemberByEmail: async (organizationId: string, email: string) =>
    state.members.find(
      (m) => m.organizationId === organizationId && m.email === email,
    ) ?? null,
  listMembersOffset: async (
    organizationId: string,
    startIndex: number,
    count: number,
  ) => {
    const all = state.members.filter(
      (m) => m.organizationId === organizationId,
    );
    return {
      members: all.slice(startIndex - 1, startIndex - 1 + count),
      totalResults: all.length,
    };
  },
  provisionMember: async (
    organizationId: string,
    email: string,
    name: string | null,
    nameComponents: Record<string, unknown> | null,
  ) => {
    state.calls.provision.push([organizationId, email, name, nameComponents]);
    const normalized = email.trim().toLowerCase();
    const existing = state.members.find(
      (m) => m.organizationId === organizationId && m.email === normalized,
    );
    if (existing) {
      return { ...existing, created: false };
    }
    const member: MockMember = {
      organizationId,
      userId: `usr-${state.members.length + 1}`,
      email: normalized,
      name,
      nameComponents,
      role: "member",
      status: "active",
      ssoExempt: false,
      joinedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastModifiedAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    state.members.push(member);
    return { ...member, created: true };
  },
  deactivateMember: async (
    organizationId: string,
    userId: string,
    actorId: string,
  ) => {
    state.calls.deactivate.push([organizationId, userId, actorId]);
    if (state.deactivateError) throw state.deactivateError;
    const member = state.members.find(
      (m) => m.organizationId === organizationId && m.userId === userId,
    );
    if (member) member.status = "suspended";
  },
  reactivateMember: async (organizationId: string, userId: string) => {
    state.calls.reactivate.push([organizationId, userId]);
    const member = state.members.find(
      (m) => m.organizationId === organizationId && m.userId === userId,
    );
    if (member) member.status = "active";
  },
  updateMemberProfile: async (
    organizationId: string,
    userId: string,
    patch: {
      displayName?: string | null;
      nameComponents?: Record<string, unknown> | null;
    },
  ) => {
    state.calls.updateName.push([organizationId, userId, patch]);
    const member = state.members.find(
      (m) => m.organizationId === organizationId && m.userId === userId,
    );
    if (member) {
      if (patch.displayName !== undefined) member.name = patch.displayName;
      if (patch.nameComponents !== undefined) {
        member.nameComponents = patch.nameComponents;
      }
    }
  },
  renameMemberEmail: async (
    organizationId: string,
    userId: string,
    rawNewEmail: string,
  ) => {
    state.calls.rename.push([organizationId, userId, rawNewEmail]);
    if (state.renameError) throw state.renameError;
    const email = rawNewEmail.trim().toLowerCase();
    const member = state.members.find(
      (m) => m.organizationId === organizationId && m.userId === userId,
    );
    if (member) member.email = email;
    return { email };
  },
  resolveScimActor: async (organizationId: string) => ({
    userId: `owner-of-${organizationId}`,
    userEmail: "owner@x.com",
  }),
}));

import { createHash } from "node:crypto";
import { createScimApp } from "./app";
import { ServiceError } from "../../services/errors";

const app = createScimApp();

const TOKEN = "oc_scim_" + "a".repeat(48);
const OTHER_ORG_TOKEN = "oc_scim_" + "b".repeat(48);
const REVOKED_TOKEN = "oc_scim_" + "c".repeat(48);

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const request = (
  path: string,
  init: RequestInit = {},
  token: string | null = TOKEN,
) =>
  app.request(`http://scim.test${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "Content-Type": "application/scim+json" } : {}),
      ...(init.headers ?? {}),
    },
  });

const expectScimContentType = (res: Response) => {
  expect(res.headers.get("content-type")).toBe("application/scim+json");
};

const seedMember = (over: Partial<MockMember> = {}): MockMember => {
  const member: MockMember = {
    organizationId: "org-1",
    userId: "usr-1",
    email: "jane@acme.com",
    name: "Jane Doe",
    nameComponents: null,
    role: "member",
    status: "active",
    ssoExempt: false,
    joinedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastModifiedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...over,
  };
  state.members.push(member);
  return member;
};

beforeEach(() => {
  state.tokens = [
    {
      hash: sha256(TOKEN),
      id: "tok-1",
      organizationId: "org-1",
      label: "Entra",
      revokedAt: null,
    },
    {
      hash: sha256(OTHER_ORG_TOKEN),
      id: "tok-2",
      organizationId: "org-2",
      label: "Okta",
      revokedAt: null,
    },
    {
      hash: sha256(REVOKED_TOKEN),
      id: "tok-3",
      organizationId: "org-1",
      label: "old",
      revokedAt: new Date(),
    },
  ];
  state.tokenUpdates = [];
  state.members = [];
  state.deactivateError = null;
  state.renameError = null;
  state.rateCount = 0;
  state.audits = [];
  for (const key of Object.keys(state.calls) as (keyof typeof state.calls)[]) {
    state.calls[key] = [];
  }
});

// This suite exercises licensed features — run it entitled. The unlicensed
// refusal of each feature is proven in licensing/enterprise-lock.test.ts.
beforeAll(() => initEntitlementForTests(true));
afterAll(() => initEntitlementForTests(null));

describe("auth matrix", () => {
  it.each([
    ["no token", null],
    ["unknown token", "oc_scim_" + "f".repeat(48)],
    ["revoked token", REVOKED_TOKEN],
  ])("%s → SCIM-shaped hint-free 401", async (_label, token) => {
    const res = await request("/Users", {}, token);
    expect(res.status).toBe(401);
    expectScimContentType(res);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    await expect(res.json()).resolves.toEqual({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "401",
      detail: "Authentication failed.",
    });
  });

  it("a valid token scopes every read to ITS org (cross-org isolation)", async () => {
    seedMember(); // org-1
    const foreign = await request(`/Users/usr-1`, {}, OTHER_ORG_TOKEN);
    expect(foreign.status).toBe(404);

    const list = await request("/Users", {}, OTHER_ORG_TOKEN);
    const body = (await list.json()) as { totalResults: number };
    expect(body.totalResults).toBe(0);
  });

  it("touches lastUsedAt on authenticated requests", async () => {
    await request("/Users");
    // fire-and-forget — flush microtasks before asserting
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.tokenUpdates).toEqual([{ id: "tok-1" }]);
  });

  it("returns 429 once the per-token window is exhausted", async () => {
    state.rateCount = 600; // next incr → 601
    const res = await request("/Users");
    expect(res.status).toBe(429);
  });
});

describe("GET /Users", () => {
  it("Entra Test Connection: unmatched userName filter → 200 + totalResults:0", async () => {
    const res = await request(
      `/Users?filter=${encodeURIComponent('userName eq "77c4b9e5-5a3d-4b2e-9f1a-000000000000"')}`,
    );
    expect(res.status).toBe(200);
    expectScimContentType(res);
    await expect(res.json()).resolves.toEqual({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: 0,
      startIndex: 1,
      itemsPerPage: 0,
      Resources: [],
    });
  });

  it("userName eq filter returns the full resource shape", async () => {
    seedMember();
    const res = await request(
      `/Users?filter=${encodeURIComponent('userName eq "jane@acme.com"')}`,
    );
    const body = (await res.json()) as {
      totalResults: number;
      Resources: Record<string, unknown>[];
    };
    expect(body.totalResults).toBe(1);
    expect(body.Resources[0]).toEqual({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      id: "usr-1",
      userName: "jane@acme.com",
      displayName: "Jane Doe",
      name: { formatted: "Jane Doe" },
      emails: [{ value: "jane@acme.com", primary: true }],
      active: true,
      meta: {
        resourceType: "User",
        created: "2026-01-01T00:00:00.000Z",
        lastModified: "2026-01-02T00:00:00.000Z",
        location: "http://scim.test/scim/v2/Users/usr-1",
      },
    });
  });

  it("externalId eq → 400 invalidFilter with userName guidance (documented limitation)", async () => {
    const res = await request(
      `/Users?filter=${encodeURIComponent('externalId eq "00u1abcd"')}`,
    );
    expect(res.status).toBe(400);
    expectScimContentType(res);
    const body = (await res.json()) as { scimType: string; detail: string };
    expect(body.scimType).toBe("invalidFilter");
    expect(body.detail).toContain("userName");
  });

  it("paginates with 1-based startIndex", async () => {
    for (let i = 1; i <= 5; i++) {
      seedMember({ userId: `usr-${i}`, email: `u${i}@acme.com` });
    }
    const res = await request("/Users?startIndex=3&count=2");
    const body = (await res.json()) as {
      totalResults: number;
      startIndex: number;
      itemsPerPage: number;
      Resources: { id: string }[];
    };
    expect(body).toMatchObject({
      totalResults: 5,
      startIndex: 3,
      itemsPerPage: 2,
    });
    expect(body.Resources.map((r) => r.id)).toEqual(["usr-3", "usr-4"]);
  });
});

describe("GET /Users/:id", () => {
  it("suspended members read back active:false", async () => {
    seedMember({ status: "suspended" });
    const res = await request("/Users/usr-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active: boolean };
    expect(body.active).toBe(false);
  });

  it("unknown id → SCIM-shaped 404 with a string status", async () => {
    const res = await request("/Users/ghost");
    expect(res.status).toBe(404);
    expectScimContentType(res);
    await expect(res.json()).resolves.toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "404",
    });
  });
});

describe("POST /Users", () => {
  it("provisions and returns 201 + Location", async () => {
    const res = await request("/Users", {
      method: "POST",
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "New@Acme.com",
        name: { givenName: "New", familyName: "Person" },
        active: true,
      }),
    });
    expect(res.status).toBe(201);
    expectScimContentType(res);
    expect(res.headers.get("location")).toBe(
      "http://scim.test/scim/v2/Users/usr-1",
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      userName: "new@acme.com",
      displayName: "New Person",
      name: { givenName: "New", familyName: "Person" },
      active: true,
    });
    expect(state.calls.provision).toEqual([
      [
        "org-1",
        "New@Acme.com",
        "New Person",
        { givenName: "New", familyName: "Person" },
      ],
    ]);
    expect(state.audits).toEqual([
      expect.objectContaining({ action: "create", service: "member" }),
    ]);
  });

  it("duplicate userName → 409 uniqueness (Okta halts + shows detail)", async () => {
    seedMember();
    const res = await request("/Users", {
      method: "POST",
      body: JSON.stringify({ userName: "jane@acme.com" }),
    });
    expect(res.status).toBe(409);
    expectScimContentType(res);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "409",
      scimType: "uniqueness",
      detail:
        'A user with userName "jane@acme.com" already exists in this organization.',
    });
    expect(state.audits).toHaveLength(0);
  });

  it("missing userName → 400 invalidValue", async () => {
    const res = await request("/Users", {
      method: "POST",
      body: JSON.stringify({ displayName: "No Name" }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      scimType: "invalidValue",
    });
  });

  it("active:false on create provisions suspended", async () => {
    const res = await request("/Users", {
      method: "POST",
      body: JSON.stringify({ userName: "off@acme.com", active: false }),
    });
    expect(res.status).toBe(201);
    expect(state.calls.deactivate).toEqual([
      ["org-1", "usr-1", "owner-of-org-1"],
    ]);
    const body = (await res.json()) as { active: boolean };
    expect(body.active).toBe(false);
  });
});

describe("PUT /Users/:id (full replace)", () => {
  it("userName change renames via the guarded directory path", async () => {
    seedMember();
    const res = await request("/Users/usr-1", {
      method: "PUT",
      body: JSON.stringify({ userName: "renamed@acme.com", active: true }),
    });
    expect(res.status).toBe(200);
    expect(state.calls.rename).toEqual([
      ["org-1", "usr-1", "renamed@acme.com"],
    ]);
    const body = (await res.json()) as { userName: string };
    expect(body.userName).toBe("renamed@acme.com");
  });

  it("guard rejections surface as 400 mutability (multi-org member)", async () => {
    seedMember();
    state.renameError = new ServiceError(
      "BAD_REQUEST",
      "userName cannot be changed for a user who belongs to multiple organizations.",
    );
    const res = await request("/Users/usr-1", {
      method: "PUT",
      body: JSON.stringify({ userName: "renamed@acme.com" }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      status: "400",
      scimType: "mutability",
    });
  });

  it("applies active + name and returns the updated resource", async () => {
    seedMember();
    const res = await request("/Users/usr-1", {
      method: "PUT",
      body: JSON.stringify({
        userName: "JANE@acme.com", // same identity, case-insensitive
        displayName: "Jane Updated",
        active: false,
      }),
    });
    expect(res.status).toBe(200);
    expect(state.calls.updateName).toEqual([
      ["org-1", "usr-1", { displayName: "Jane Updated" }],
    ]);
    expect(state.calls.deactivate).toHaveLength(1);
    const body = (await res.json()) as { active: boolean; displayName: string };
    expect(body).toMatchObject({ active: false, displayName: "Jane Updated" });
    expect(state.audits).toHaveLength(1);
  });
});

describe("PUT name components", () => {
  it("PUT applies a name components object (Okta wizard profile push)", async () => {
    seedMember();
    const res = await request("/Users/usr-1", {
      method: "PUT",
      body: JSON.stringify({
        userName: "jane@acme.com",
        name: { givenName: "Jane", familyName: "Doe" },
      }),
    });
    expect(res.status).toBe(200);
    expect(state.calls.updateName).toEqual([
      [
        "org-1",
        "usr-1",
        { nameComponents: { givenName: "Jane", familyName: "Doe" } },
      ],
    ]);
    const body = (await res.json()) as { name: Record<string, unknown> };
    expect(body.name).toEqual({ givenName: "Jane", familyName: "Doe" });
  });
});

describe("PATCH /Users/:id — the recorded IdP quirk matrix", () => {
  const patch = (operations: unknown[]) =>
    request("/Users/usr-1", {
      method: "PATCH",
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: operations,
      }),
    });

  it('Entra deactivate: {op:"Replace", path:"active", value:"False"}', async () => {
    seedMember();
    const res = await patch([
      { op: "Replace", path: "active", value: "False" },
    ]);
    expect(res.status).toBe(200);
    expect(state.calls.deactivate).toEqual([
      ["org-1", "usr-1", "owner-of-org-1"],
    ]);
    const body = (await res.json()) as { active: boolean };
    expect(body.active).toBe(false);
  });

  it("Okta reactivate: no-path replace with an object value", async () => {
    seedMember({ status: "suspended" });
    const res = await patch([{ op: "replace", value: { active: "True" } }]);
    expect(res.status).toBe(200);
    expect(state.calls.reactivate).toEqual([["org-1", "usr-1"]]);
  });

  it("same-state active flip is idempotent — no dispatch, no audit", async () => {
    seedMember(); // already active
    const res = await patch([{ op: "replace", path: "active", value: true }]);
    expect(res.status).toBe(200);
    expect(state.calls.deactivate).toHaveLength(0);
    expect(state.calls.reactivate).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it("owner deactivation surfaces the guard as a 400 detail, never a 500", async () => {
    seedMember({ role: "owner" });
    state.deactivateError = new ServiceError(
      "BAD_REQUEST",
      "The organization owner cannot be deactivated. Transfer ownership first.",
    );
    const res = await patch([
      { op: "Replace", path: "active", value: "False" },
    ]);
    expect(res.status).toBe(400);
    expectScimContentType(res);
    await expect(res.json()).resolves.toEqual({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "400",
      scimType: "invalidValue",
      detail:
        "The organization owner cannot be deactivated. Transfer ownership first.",
    });
  });

  it("routes name.formatted to components and displayName to the display string", async () => {
    seedMember();
    await patch([{ op: "replace", path: "name.formatted", value: "N1" }]);
    await patch([{ op: "Replace", path: "displayName", value: "N2" }]);
    expect(state.calls.updateName).toEqual([
      ["org-1", "usr-1", { nameComponents: { formatted: "N1" } }],
      ["org-1", "usr-1", { displayName: "N2" }],
    ]);
  });

  it("ignores unmapped paths without failing the sync", async () => {
    seedMember();
    const res = await patch([
      { op: "replace", path: "emails", value: [{ value: "x@y.com" }] },
      { op: "add", path: "externalId", value: "00u123" },
    ]);
    expect(res.status).toBe(200);
    expect(state.audits).toHaveLength(0);
  });

  it("rejects a PatchOp without the PatchOp schema", async () => {
    seedMember();
    const res = await request("/Users/usr-1", {
      method: "PATCH",
      body: JSON.stringify({
        Operations: [{ op: "replace", path: "active", value: false }],
      }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      scimType: "invalidSyntax",
    });
  });
});

describe("Entra validator fixtures (recorded request shapes)", () => {
  it("POST round-trips displayName and name components independently", async () => {
    // The validator's failing case: formatted/given/family are unrelated
    // to displayName and must each fetch back exactly.
    const post = await request("/Users", {
      method: "POST",
      body: JSON.stringify({
        userName: "milan@littel.info",
        displayName: "GCAERADSPRLQ",
        name: {
          formatted: "Leila",
          givenName: "Rupert",
          familyName: "Abraham",
        },
        active: true,
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      }),
    });
    expect(post.status).toBe(201);
    const created = (await post.json()) as { id: string };

    const get = await request(`/Users/${created.id}`);
    const body = (await get.json()) as Record<string, unknown>;
    expect(body.displayName).toBe("GCAERADSPRLQ");
    expect(body.name).toEqual({
      formatted: "Leila",
      givenName: "Rupert",
      familyName: "Abraham",
    });
  });

  it("no-path PATCH with DOTTED keys replaces name components", async () => {
    seedMember({
      name: "TODHMQHIXKBO",
      nameComponents: {
        formatted: "Allan",
        givenName: "Maudie",
        familyName: "Elenor",
      },
    });
    const res = await request("/Users/usr-1", {
      method: "PATCH",
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [
          {
            op: "replace",
            value: {
              displayName: "ITXEQNROZXSU",
              "name.formatted": "Corbin",
              "name.givenName": "Nils",
              "name.familyName": "Nico",
              active: true,
            },
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.displayName).toBe("ITXEQNROZXSU");
    expect(body.name).toEqual({
      formatted: "Corbin",
      givenName: "Nils",
      familyName: "Nico",
    });
  });

  it("no-path PATCH userName replace renames the user", async () => {
    seedMember({ email: "sylvan_kulas@shieldslabadie.ca" });
    const res = await request("/Users/usr-1", {
      method: "PATCH",
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [
          { op: "replace", value: { userName: "corrine@halvorson.biz" } },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(state.calls.rename).toEqual([
      ["org-1", "usr-1", "corrine@halvorson.biz"],
    ]);
    const body = (await res.json()) as { userName: string };
    expect(body.userName).toBe("corrine@halvorson.biz");
  });

  it("rename collisions surface as 409 uniqueness", async () => {
    seedMember();
    state.renameError = new ServiceError(
      "CONFLICT",
      "A user with this userName already exists.",
    );
    const res = await request("/Users/usr-1", {
      method: "PATCH",
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "userName", value: "taken@x.com" }],
      }),
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      status: "409",
      scimType: "uniqueness",
    });
  });

  it("honors X-Forwarded-Proto in meta.location (CloudFront/ALB TLS)", async () => {
    seedMember();
    const res = await request("/Users/usr-1", {
      headers: { "x-forwarded-proto": "https" },
    });
    const body = (await res.json()) as { meta: { location: string } };
    expect(body.meta.location).toBe("https://scim.test/scim/v2/Users/usr-1");
    expect(res.headers.get("content-location")).toBe(body.meta.location);
  });
});

describe("DELETE /Users/:id", () => {
  it("deactivates (never deletes) and returns 204", async () => {
    seedMember();
    const res = await request("/Users/usr-1", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(state.calls.deactivate).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
    // the member still exists — reversible suspension
    expect(state.members[0]!.status).toBe("suspended");
  });

  it("repeat DELETE answers 404 — the Entra expectation for a deleted resource", async () => {
    // The suspension itself is untouched (member row survives); Entra
    // treats 404-on-DELETE as already-gone, incl. lost-response retries.
    seedMember({ status: "suspended" });
    const res = await request("/Users/usr-1", { method: "DELETE" });
    expect(res.status).toBe(404);
    expectScimContentType(res);
    await expect(res.json()).resolves.toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "404",
    });
    expect(state.calls.deactivate).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
    expect(state.members[0]!.status).toBe("suspended");
  });
});

describe("discovery", () => {
  it("ServiceProviderConfig declares patch+filter, no bulk", async () => {
    const res = await request("/ServiceProviderConfig");
    expect(res.status).toBe(200);
    expectScimContentType(res);
    const body = (await res.json()) as Record<string, { supported: boolean }>;
    expect(body.patch).toEqual({ supported: true });
    expect(body.filter).toMatchObject({ supported: true });
    expect(body.bulk).toMatchObject({ supported: false });
    expect(body.changePassword).toEqual({ supported: false });
  });

  it("unknown routes get a SCIM-shaped 404", async () => {
    const res = await request("/Bulk", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    expectScimContentType(res);
    await expect(res.json()).resolves.toMatchObject({ status: "404" });
  });
});

describe("host mounting", () => {
  it("serves under a /scim/v2 prefix mount — the shape BOTH hosts use", async () => {
    // api-server: app.route("/scim/v2", createScimApp()); web: the same
    // wrap inside the api-server's SCIM mount. meta.location must still be
    // absolute /scim/v2 URLs.
    const { Hono } = await import("hono");
    const mounted = new Hono().route("/scim/v2", createScimApp());
    seedMember();
    const res = await mounted.request("http://scim.test/scim/v2/Users/usr-1", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { location: string } };
    expect(body.meta.location).toBe("http://scim.test/scim/v2/Users/usr-1");
  });

  it("mounted misses stay SCIM-shaped (Hono drops sub-app notFound)", async () => {
    // A host app's generic 404 would otherwise answer for unmatched SCIM
    // paths — the catch-all route keeps the error contract through mounts.
    const { Hono } = await import("hono");
    const host = new Hono();
    host.route("/scim/v2", createScimApp());
    host.notFound((c) => c.json({ error: "HOST-404" }, 404));

    for (const path of ["/scim/v2", "/scim/v2/Bulk"]) {
      const res = await host.request(`http://scim.test${path}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("application/scim+json");
      await expect(res.json()).resolves.toMatchObject({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        status: "404",
      });
    }
  });

  it("mounted errors keep the SCIM error mapping (sub-app onError survives)", async () => {
    const { Hono } = await import("hono");
    const mounted = new Hono().route("/scim/v2", createScimApp());
    seedMember({ role: "owner" });
    state.deactivateError = new ServiceError(
      "BAD_REQUEST",
      "The organization owner cannot be deactivated. Transfer ownership first.",
    );
    const res = await mounted.request("http://scim.test/scim/v2/Users/usr-1", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/scim+json",
      },
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "Replace", path: "active", value: "False" }],
      }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      status: "400",
      scimType: "invalidValue",
    });
  });
});

describe("RFC 7644 conformance (audited against the normative text)", () => {
  it("PATCH remove without path → 400 noTarget (§3.5.2.2)", async () => {
    seedMember();
    const res = await request("/Users/usr-1", {
      method: "PATCH",
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "remove" }],
      }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ scimType: "noTarget" });
  });

  it("/Me → 501 Not Implemented (§3.11), SCIM-shaped", async () => {
    const res = await request("/Me");
    expect(res.status).toBe(501);
    expectScimContentType(res);
    await expect(res.json()).resolves.toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "501",
    });
  });

  it("single-resource responses carry Content-Location = meta.location (RFC 7643 §3.1)", async () => {
    seedMember();
    const get = await request("/Users/usr-1");
    expect(get.headers.get("content-location")).toBe(
      "http://scim.test/scim/v2/Users/usr-1",
    );

    const post = await request("/Users", {
      method: "POST",
      body: JSON.stringify({ userName: "new@acme.com" }),
    });
    expect(post.status).toBe(201);
    expect(post.headers.get("location")).toBe(
      post.headers.get("content-location"),
    );
    const body = (await post.json()) as { meta: { location: string } };
    expect(post.headers.get("location")).toBe(body.meta.location);
  });

  it("meta carries lastModified alongside created (RFC 7643 §3.1)", async () => {
    seedMember();
    const res = await request("/Users/usr-1");
    const body = (await res.json()) as {
      meta: { created: string; lastModified: string };
    };
    expect(body.meta.lastModified).toBe("2026-01-02T00:00:00.000Z");
    expect(body.meta.lastModified >= body.meta.created).toBe(true);
  });

  it("filter on configuration endpoints → 403 (§4)", async () => {
    for (const path of [
      "/ServiceProviderConfig",
      "/ResourceTypes",
      "/Schemas",
    ]) {
      const res = await request(
        `${path}?filter=${encodeURIComponent('id eq "User"')}`,
      );
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ status: "403" });
    }
  });

  it("serves single-resource configuration GETs (§4)", async () => {
    const resourceType = await request("/ResourceTypes/User");
    expect(resourceType.status).toBe(200);
    await expect(resourceType.json()).resolves.toMatchObject({
      id: "User",
      endpoint: "/Users",
    });

    const schema = await request(
      "/Schemas/urn:ietf:params:scim:schemas:core:2.0:User",
    );
    expect(schema.status).toBe(200);
    await expect(schema.json()).resolves.toMatchObject({
      id: "urn:ietf:params:scim:schemas:core:2.0:User",
    });

    expect((await request("/ResourceTypes/Ghost")).status).toBe(404);
  });

  it("declares userName readWrite — renames are honored (guarded)", async () => {
    const res = await request(
      "/Schemas/urn:ietf:params:scim:schemas:core:2.0:User",
    );
    const body = (await res.json()) as {
      attributes: { name: string; mutability: string }[];
    };
    const userName = body.attributes.find((a) => a.name === "userName");
    expect(userName?.mutability).toBe("readWrite");
  });
});
