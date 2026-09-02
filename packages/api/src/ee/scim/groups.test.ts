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

// /scim/v2/Groups over the real scim app with the directory service mocked:
// Okta's Push Groups flow (displayName eq lookup, empty-members create,
// both member-remove syntaxes), Entra's excludedAttributes=members,
// externalId round-trip, name-collision 409, and cross-org isolation.

interface MockGroup {
  organizationId: string;
  id: string;
  name: string;
  externalId: string | null;
  createdAt: Date;
  updatedAt: Date;
  members: { userId: string; email: string }[];
}

const state = vi.hoisted(() => ({
  tokens: [] as {
    hash: string;
    id: string;
    organizationId: string;
    label: string;
    revokedAt: Date | null;
  }[],
  groups: [] as MockGroup[],
  calls: {
    create: [] as unknown[][],
    rename: [] as unknown[][],
    del: [] as unknown[][],
    setMembers: [] as unknown[][],
    addMember: [] as unknown[][],
    removeMember: [] as unknown[][],
    setExternalId: [] as unknown[][],
  },
  externalIdError: null as Error | null,
  audits: [] as { action: string; service: string; metadata: unknown }[],
}));

vi.mock("@onecli/db", () => ({
  db: {
    organizationScimToken: {
      findUnique: async ({ where }: { where: { tokenHash: string } }) => {
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
      update: async () => ({}),
    },
  },
}));

vi.mock("../clients/redis-client", () => ({
  hasRedisConfigured: () => true,
  getRedis: () => ({ incr: async () => 1, expire: async () => 1 }),
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

const findGroup = (organizationId: string, groupId: string) =>
  state.groups.find(
    (g) => g.organizationId === organizationId && g.id === groupId,
  );

vi.mock("../services/org-directory-service", () => ({
  // users surface (imported by users.ts in the same app graph — inert here)
  findMemberByUserId: async () => null,
  findMemberByEmail: async () => null,
  listMembersOffset: async () => ({ members: [], totalResults: 0 }),
  provisionMember: async () => {
    throw new Error("not under test");
  },
  deactivateMember: async () => {},
  reactivateMember: async () => {},
  updateMemberProfile: async () => {},
  renameMemberEmail: async () => ({ email: "x@x.com" }),
  resolveScimActor: async (organizationId: string) => ({
    userId: `owner-of-${organizationId}`,
    userEmail: "owner@x.com",
  }),

  // groups surface
  listGroupsOffset: async (
    organizationId: string,
    startIndex: number,
    count: number,
    options: {
      filter?: { attribute: string; value: string };
      includeMembers: boolean;
    },
  ) => {
    let all = state.groups.filter((g) => g.organizationId === organizationId);
    if (options.filter?.attribute === "displayname") {
      const needle = options.filter.value.toLowerCase();
      all = all.filter((g) => g.name.toLowerCase() === needle);
    } else if (options.filter?.attribute === "externalid") {
      all = all.filter((g) => g.externalId === options.filter!.value);
    }
    return {
      groups: all.slice(startIndex - 1, startIndex - 1 + count).map((g) => ({
        id: g.id,
        name: g.name,
        externalId: g.externalId,
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
        members: options.includeMembers ? g.members : null,
      })),
      totalResults: all.length,
    };
  },
  findScimGroupById: async (
    organizationId: string,
    groupId: string,
    includeMembers = true,
  ) => {
    const group = findGroup(organizationId, groupId);
    if (!group) return null;
    return {
      id: group.id,
      name: group.name,
      externalId: group.externalId,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      members: includeMembers ? group.members : null,
    };
  },
  scimCreateGroup: async (
    organizationId: string,
    name: string,
    externalId: string | null,
  ) => {
    state.calls.create.push([organizationId, name, externalId]);
    if (
      state.groups.some(
        (g) => g.organizationId === organizationId && g.name === name,
      )
    ) {
      const { ServiceError } = await import("../../services/errors");
      throw new ServiceError(
        "CONFLICT",
        "A group with this name already exists.",
      );
    }
    const group: MockGroup = {
      organizationId,
      id: `grp-${state.groups.length + 1}`,
      name,
      externalId,
      createdAt: new Date("2026-02-02T00:00:00.000Z"),
      updatedAt: new Date("2026-02-03T00:00:00.000Z"),
      members: [],
    };
    state.groups.push(group);
    return { id: group.id, name, source: "scim", externalId };
  },
  scimSetGroupExternalId: async (
    organizationId: string,
    groupId: string,
    externalId: string | null,
  ) => {
    state.calls.setExternalId.push([organizationId, groupId, externalId]);
    if (state.externalIdError) throw state.externalIdError;
    const group = findGroup(organizationId, groupId);
    if (group) group.externalId = externalId;
  },
  scimRenameGroup: async (
    organizationId: string,
    groupId: string,
    name: string,
  ) => {
    state.calls.rename.push([organizationId, groupId, name]);
    const group = findGroup(organizationId, groupId);
    if (group) group.name = name;
    return {};
  },
  scimDeleteGroup: async (organizationId: string, groupId: string) => {
    state.calls.del.push([organizationId, groupId]);
    state.groups = state.groups.filter(
      (g) => !(g.organizationId === organizationId && g.id === groupId),
    );
  },
  scimSetGroupMembers: async (
    organizationId: string,
    groupId: string,
    userIds: string[],
  ) => {
    state.calls.setMembers.push([organizationId, groupId, userIds]);
    const group = findGroup(organizationId, groupId);
    if (group) {
      group.members = userIds.map((id) => ({
        userId: id,
        email: `${id}@acme.com`,
      }));
    }
    return { added: userIds.length, removed: 0 };
  },
  scimAddGroupMember: async (
    organizationId: string,
    groupId: string,
    userId: string,
  ) => {
    state.calls.addMember.push([organizationId, groupId, userId]);
    const group = findGroup(organizationId, groupId);
    if (group && !group.members.some((m) => m.userId === userId)) {
      group.members.push({ userId, email: `${userId}@acme.com` });
    }
    return { added: true };
  },
  scimRemoveGroupMember: async (
    organizationId: string,
    groupId: string,
    userId: string,
  ) => {
    state.calls.removeMember.push([organizationId, groupId, userId]);
    const group = findGroup(organizationId, groupId);
    if (group) {
      group.members = group.members.filter((m) => m.userId !== userId);
    }
    return { removed: true };
  },
}));

import { createHash } from "node:crypto";
import { createScimApp } from "./app";

const app = createScimApp();

const TOKEN = "oc_scim_" + "a".repeat(48);
const OTHER_ORG_TOKEN = "oc_scim_" + "b".repeat(48);

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const request = (path: string, init: RequestInit = {}, token: string = TOKEN) =>
  app.request(`http://scim.test${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/scim+json" } : {}),
      ...(init.headers ?? {}),
    },
  });

const seedGroup = (over: Partial<MockGroup> = {}): MockGroup => {
  const group: MockGroup = {
    organizationId: "org-1",
    id: "grp-1",
    name: "Engineering",
    externalId: null,
    createdAt: new Date("2026-02-02T00:00:00.000Z"),
    updatedAt: new Date("2026-02-03T00:00:00.000Z"),
    members: [],
    ...over,
  };
  state.groups.push(group);
  return group;
};

beforeEach(() => {
  state.tokens = [
    {
      hash: sha256(TOKEN),
      id: "tok-1",
      organizationId: "org-1",
      label: "Okta",
      revokedAt: null,
    },
    {
      hash: sha256(OTHER_ORG_TOKEN),
      id: "tok-2",
      organizationId: "org-2",
      label: "Entra",
      revokedAt: null,
    },
  ];
  state.groups = [];
  state.audits = [];
  state.externalIdError = null;
  for (const key of Object.keys(state.calls) as (keyof typeof state.calls)[]) {
    state.calls[key] = [];
  }
});

// This suite exercises licensed features — run it entitled. The unlicensed
// refusal of each feature is proven in licensing/enterprise-lock.test.ts.
beforeAll(() => initEntitlementForTests(true));
afterAll(() => initEntitlementForTests(null));

describe("GET /Groups", () => {
  it("Okta Push Groups lookup: displayName eq, case-insensitive", async () => {
    seedGroup({ externalId: "okta-grp-9" });
    const res = await request(
      `/Groups?filter=${encodeURIComponent('displayName eq "engineering"')}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalResults: number;
      Resources: Record<string, unknown>[];
    };
    expect(body.totalResults).toBe(1);
    expect(body.Resources[0]).toEqual({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      id: "grp-1",
      displayName: "Engineering",
      externalId: "okta-grp-9",
      members: [],
      meta: {
        resourceType: "Group",
        created: "2026-02-02T00:00:00.000Z",
        lastModified: "2026-02-03T00:00:00.000Z",
        location: "http://scim.test/scim/v2/Groups/grp-1",
      },
    });
  });

  it("externalId eq round-trips (groups DO store it)", async () => {
    seedGroup({ externalId: "ext-42" });
    seedGroup({ id: "grp-2", name: "Sales", externalId: "ext-43" });
    const res = await request(
      `/Groups?filter=${encodeURIComponent('externalId eq "ext-43"')}`,
    );
    const body = (await res.json()) as {
      totalResults: number;
      Resources: { id: string }[];
    };
    expect(body.totalResults).toBe(1);
    expect(body.Resources[0]!.id).toBe("grp-2");
  });

  it("Entra excludedAttributes=members omits the members array", async () => {
    seedGroup({ members: [{ userId: "u1", email: "u1@acme.com" }] });
    const res = await request("/Groups?excludedAttributes=members");
    const body = (await res.json()) as {
      Resources: Record<string, unknown>[];
    };
    expect(body.Resources[0]).not.toHaveProperty("members");
  });

  it("no match → 200 with totalResults 0, never 404", async () => {
    const res = await request(
      `/Groups?filter=${encodeURIComponent('displayName eq "Ghosts"')}`,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ totalResults: 0 });
  });
});

describe("GET /Groups/:id", () => {
  it("serializes members with $ref links", async () => {
    seedGroup({ members: [{ userId: "u1", email: "u1@acme.com" }] });
    const res = await request("/Groups/grp-1");
    const body = (await res.json()) as { members: unknown[] };
    expect(body.members).toEqual([
      {
        value: "u1",
        display: "u1@acme.com",
        $ref: "http://scim.test/scim/v2/Users/u1",
      },
    ]);
  });

  it("cross-org token → 404", async () => {
    seedGroup();
    const res = await request("/Groups/grp-1", {}, OTHER_ORG_TOKEN);
    expect(res.status).toBe(404);
  });
});

describe("POST /Groups", () => {
  it("Okta create: empty members, externalId persisted, 201 + Location", async () => {
    const res = await request("/Groups", {
      method: "POST",
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        displayName: "Engineering",
        externalId: "00g1okta",
        members: [],
      }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe(
      "http://scim.test/scim/v2/Groups/grp-1",
    );
    expect(state.calls.create).toEqual([["org-1", "Engineering", "00g1okta"]]);
    expect(state.calls.setMembers).toHaveLength(0); // empty list → no set call
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      displayName: "Engineering",
      externalId: "00g1okta",
    });
    expect(state.audits).toEqual([
      expect.objectContaining({ action: "create", service: "group" }),
    ]);
  });

  it("create with members seeds the member set", async () => {
    await request("/Groups", {
      method: "POST",
      body: JSON.stringify({
        displayName: "Sales",
        members: [{ value: "u1" }, { value: "u2" }],
      }),
    });
    expect(state.calls.setMembers).toEqual([["org-1", "grp-1", ["u1", "u2"]]]);
  });

  it("duplicate displayName → 409 uniqueness with a customer-facing detail", async () => {
    seedGroup();
    const res = await request("/Groups", {
      method: "POST",
      body: JSON.stringify({ displayName: "Engineering" }),
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "409",
      scimType: "uniqueness",
      detail: "A group with this name already exists.",
    });
  });
});

describe("PUT /Groups/:id (full replace)", () => {
  it("renames and replaces the full member set", async () => {
    seedGroup({ members: [{ userId: "u1", email: "u1@acme.com" }] });
    const res = await request("/Groups/grp-1", {
      method: "PUT",
      body: JSON.stringify({
        displayName: "Engineering EMEA",
        members: [{ value: "u2" }, { value: "u3" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(state.calls.rename).toEqual([
      ["org-1", "grp-1", "Engineering EMEA"],
    ]);
    expect(state.calls.setMembers).toEqual([["org-1", "grp-1", ["u2", "u3"]]]);
    const body = (await res.json()) as { displayName: string };
    expect(body.displayName).toBe("Engineering EMEA");
  });

  it("PUT without members leaves membership untouched", async () => {
    seedGroup({ members: [{ userId: "u1", email: "u1@acme.com" }] });
    await request("/Groups/grp-1", {
      method: "PUT",
      body: JSON.stringify({ displayName: "Engineering" }),
    });
    expect(state.calls.setMembers).toHaveLength(0);
  });
});

describe("PATCH /Groups/:id", () => {
  const patch = (operations: unknown[]) =>
    request("/Groups/grp-1", {
      method: "PATCH",
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: operations,
      }),
    });

  it("adds members (Okta assignment push)", async () => {
    seedGroup();
    const res = await patch([
      { op: "add", path: "members", value: [{ value: "u1" }, { value: "u2" }] },
    ]);
    expect(res.status).toBe(200);
    expect(state.calls.addMember).toEqual([
      ["org-1", "grp-1", "u1"],
      ["org-1", "grp-1", "u2"],
    ]);
  });

  it('Okta remove syntax 1: path members[value eq "id"]', async () => {
    seedGroup({ members: [{ userId: "u1", email: "u1@acme.com" }] });
    const res = await patch([{ op: "remove", path: 'members[value eq "u1"]' }]);
    expect(res.status).toBe(200);
    expect(state.calls.removeMember).toEqual([["org-1", "grp-1", "u1"]]);
  });

  it("Okta remove syntax 2: op-level value array", async () => {
    seedGroup({ members: [{ userId: "u1", email: "u1@acme.com" }] });
    const res = await patch([
      { op: "remove", path: "members", value: [{ value: "u1" }] },
    ]);
    expect(res.status).toBe(200);
    expect(state.calls.removeMember).toEqual([["org-1", "grp-1", "u1"]]);
  });

  it("remove members without value clears the set", async () => {
    seedGroup({ members: [{ userId: "u1", email: "u1@acme.com" }] });
    await patch([{ op: "remove", path: "members" }]);
    expect(state.calls.setMembers).toEqual([["org-1", "grp-1", []]]);
  });

  it("replace members swaps the whole set", async () => {
    seedGroup({ members: [{ userId: "u1", email: "u1@acme.com" }] });
    await patch([{ op: "replace", path: "members", value: [{ value: "u9" }] }]);
    expect(state.calls.setMembers).toEqual([["org-1", "grp-1", ["u9"]]]);
  });

  it("renames via path and via Okta's no-path object (capitalized op)", async () => {
    seedGroup();
    await patch([{ op: "replace", path: "displayName", value: "R1" }]);
    await patch([{ op: "Replace", value: { id: "grp-1", displayName: "R2" } }]);
    expect(state.calls.rename).toEqual([
      ["org-1", "grp-1", "R1"],
      ["org-1", "grp-1", "R2"],
    ]);
  });

  it("member entries without a value id → 400 invalidValue", async () => {
    seedGroup();
    const res = await patch([
      { op: "add", path: "members", value: [{ display: "no id" }] },
    ]);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      scimType: "invalidValue",
    });
  });

  it("audits one update per PATCH", async () => {
    seedGroup();
    await patch([
      { op: "add", path: "members", value: [{ value: "u1" }] },
      { op: "replace", path: "displayName", value: "Renamed" },
    ]);
    expect(state.audits).toEqual([
      expect.objectContaining({ action: "update", service: "group" }),
    ]);
  });
});

describe("Entra validator fixtures — externalId updates", () => {
  const patch = (operations: unknown[]) =>
    request("/Groups/grp-1", {
      method: "PATCH",
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: operations,
      }),
    });

  it("no-path replace updates externalId (the recorded shape)", async () => {
    seedGroup({ externalId: "2c97c1b2-3785-4685-b40f-d322ace2ac51" });
    const res = await patch([
      {
        op: "replace",
        value: { externalId: "952fe503-297e-4d79-aed9-e445928fcaad" },
      },
    ]);
    expect(res.status).toBe(200);
    expect(state.calls.setExternalId).toEqual([
      ["org-1", "grp-1", "952fe503-297e-4d79-aed9-e445928fcaad"],
    ]);
    const body = (await res.json()) as { externalId: string };
    expect(body.externalId).toBe("952fe503-297e-4d79-aed9-e445928fcaad");
  });

  it("path form replaces and remove clears", async () => {
    seedGroup({ externalId: "old" });
    await patch([{ op: "replace", path: "externalId", value: "new-id" }]);
    await patch([{ op: "remove", path: "externalId" }]);
    expect(state.calls.setExternalId).toEqual([
      ["org-1", "grp-1", "new-id"],
      ["org-1", "grp-1", null],
    ]);
  });

  it("collision surfaces as 409 uniqueness", async () => {
    seedGroup();
    const { ServiceError } = await import("../../services/errors");
    state.externalIdError = new ServiceError(
      "CONFLICT",
      "A group with this externalId already exists.",
    );
    const res = await patch([
      { op: "replace", path: "externalId", value: "dup" },
    ]);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      status: "409",
      scimType: "uniqueness",
    });
  });

  it("PUT applies a changed externalId", async () => {
    seedGroup({ externalId: "old" });
    const res = await request("/Groups/grp-1", {
      method: "PUT",
      body: JSON.stringify({
        displayName: "Engineering",
        externalId: "put-id",
      }),
    });
    expect(res.status).toBe(200);
    expect(state.calls.setExternalId).toEqual([["org-1", "grp-1", "put-id"]]);
  });
});

describe("DELETE /Groups/:id", () => {
  it("deletes and audits", async () => {
    seedGroup();
    const res = await request("/Groups/grp-1", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(state.calls.del).toEqual([["org-1", "grp-1"]]);
    expect(state.audits).toEqual([
      expect.objectContaining({ action: "delete", service: "group" }),
    ]);
  });

  it("cross-org delete is a 404, nothing deleted", async () => {
    seedGroup();
    const res = await request(
      "/Groups/grp-1",
      { method: "DELETE" },
      OTHER_ORG_TOKEN,
    );
    expect(res.status).toBe(404);
    expect(state.calls.del).toHaveLength(0);
  });
});
