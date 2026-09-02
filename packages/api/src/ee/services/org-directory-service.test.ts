import { beforeEach, describe, expect, it, vi } from "vitest";

// Directory-core tests over a hand-rolled db mock: the scim- placeholder
// user shape, provision idempotency (the SCIM 409 path), idempotent
// de/reactivation that still propagates the human guards, SCIM protocol
// pagination math, and the scim group wrappers' pass-through semantics
// (source:"scim", actor null — the guard-free cores).

const state = vi.hoisted(() => ({
  users: [] as {
    id: string;
    email: string;
    name: string | null;
    externalAuthId: string;
  }[],
  memberships: [] as {
    organizationId: string;
    userId: string;
    userEmail: string;
    role: string;
    status: string;
    createdAt: Date;
    ssoExempt: boolean;
    userName: string | null;
    userUpdatedAt: Date;
    userExternalAuthId: string;
  }[],
  groups: [] as {
    id: string;
    organizationId: string;
    externalId: string | null;
  }[],
  apiKeys: [] as { userId: string; userEmail: string }[],
  calls: {
    userCreateData: [] as Record<string, unknown>[],
    userUpdateData: [] as Record<string, unknown>[],
    membershipCreateData: [] as Record<string, unknown>[],
    memberFindManyArgs: [] as Record<string, unknown>[],
    memberCountWhere: [] as unknown[],
  },
  failNextUserCreate: false,
  failNextEmailUpdate: false,
  failNextGroupUpdate: false,
}));

const teamCalls = vi.hoisted(() => ({
  suspend: [] as unknown[][],
  reinstate: [] as unknown[][],
  suspendError: null as Error | null,
}));

const MockPrismaKnownError = vi.hoisted(
  () =>
    class MockPrismaKnownError extends Error {
      code: string;
      constructor(code: string) {
        super(`prisma error ${code}`);
        this.code = code;
      }
    },
);

const groupCalls = vi.hoisted(() => ({
  create: [] as unknown[][],
  rename: [] as unknown[][],
  del: [] as unknown[][],
  setMembers: [] as unknown[][],
  addMember: [] as unknown[][],
  removeMember: [] as unknown[][],
}));

const toMemberRecord = (m: (typeof state.memberships)[number]) => ({
  userId: m.userId,
  userEmail: m.userEmail,
  role: m.role,
  status: m.status,
  ssoExempt: m.ssoExempt,
  createdAt: m.createdAt,
  user: {
    name: m.userName,
    nameComponents: null,
    updatedAt: m.userUpdatedAt,
    // renameMemberEmail selects these off the membership's user relation.
    email: m.userEmail,
    externalAuthId: m.userExternalAuthId,
  },
});

vi.mock("@onecli/db", () => ({
  Prisma: { PrismaClientKnownRequestError: MockPrismaKnownError },
  db: {
    user: {
      findUnique: async ({ where }: { where: { email: string } }) =>
        state.users.find((u) => u.email === where.email) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { email: string } }) => {
        const user = state.users.find((u) => u.email === where.email);
        if (!user) throw new MockPrismaKnownError("P2025");
        return user;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.calls.userCreateData.push(data);
        if (state.failNextUserCreate) {
          state.failNextUserCreate = false;
          // The race: another request inserted the row between the
          // find-miss and this create.
          state.users.push({
            id: "usr-winner",
            email: data.email as string,
            name: "Winner",
            externalAuthId: "scim-winner",
          });
          throw new MockPrismaKnownError("P2002");
        }
        const row = {
          id: `usr-${state.users.length + 1}`,
          email: data.email as string,
          name: (data.name as string | null) ?? null,
          externalAuthId: data.externalAuthId as string,
        };
        state.users.push(row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { name?: string | null; email?: string };
      }) => {
        state.calls.userUpdateData.push({ where, data });
        if (data.email !== undefined && state.failNextEmailUpdate) {
          state.failNextEmailUpdate = false;
          throw new MockPrismaKnownError("P2002");
        }
        const user = state.users.find((u) => u.id === where.id);
        if (user) {
          if (data.name !== undefined) user.name = data.name;
          if (data.email !== undefined) user.email = data.email;
        }
        return user ?? {};
      },
    },
    group: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; organizationId: string };
      }) =>
        state.groups.find(
          (g) => g.id === where.id && g.organizationId === where.organizationId,
        ) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { externalId: string | null };
      }) => {
        if (state.failNextGroupUpdate) {
          state.failNextGroupUpdate = false;
          throw new MockPrismaKnownError("P2002");
        }
        const group = state.groups.find((g) => g.id === where.id);
        if (group) group.externalId = data.externalId;
        return group ?? {};
      },
    },
    apiKey: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { userId: string };
        data: { userEmail: string };
      }) => {
        let count = 0;
        for (const k of state.apiKeys) {
          if (k.userId === where.userId) {
            k.userEmail = data.userEmail;
            count++;
          }
        }
        return { count };
      },
    },
    $transaction: async (ops: unknown[]) =>
      Promise.all(ops as Promise<unknown>[]),
    organizationMember: {
      findUnique: async ({
        where,
      }: {
        where: {
          organizationId_userId: { organizationId: string; userId: string };
        };
      }) => {
        const found = state.memberships.find(
          (m) =>
            m.organizationId === where.organizationId_userId.organizationId &&
            m.userId === where.organizationId_userId.userId,
        );
        return found ? toMemberRecord(found) : null;
      },
      findFirst: async ({
        where,
        select,
      }: {
        where: { organizationId: string; role?: string; userEmail?: string };
        select: Record<string, unknown>;
      }) => {
        const found = state.memberships.find(
          (m) =>
            m.organizationId === where.organizationId &&
            (where.role === undefined || m.role === where.role) &&
            (where.userEmail === undefined || m.userEmail === where.userEmail),
        );
        if (!found) return null;
        // Honor Prisma's select projection — resolveScimActor asserts the
        // exact shape it selected.
        const record = toMemberRecord(found) as Record<string, unknown>;
        return Object.fromEntries(
          Object.keys(select).map((key) => [key, record[key]]),
        );
      },
      findMany: async (args: {
        where: { organizationId: string };
        skip: number;
        take: number;
      }) => {
        state.calls.memberFindManyArgs.push(args);
        return state.memberships
          .filter((m) => m.organizationId === args.where.organizationId)
          .slice(args.skip, args.skip + args.take)
          .map(toMemberRecord);
      },
      count: async ({
        where,
      }: {
        where: { organizationId?: string; userId?: string };
      }) => {
        state.calls.memberCountWhere.push(where);
        return state.memberships.filter(
          (m) =>
            (where.organizationId === undefined ||
              m.organizationId === where.organizationId) &&
            (where.userId === undefined || m.userId === where.userId),
        ).length;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { userId: string };
        data: { userEmail: string };
      }) => {
        let count = 0;
        for (const m of state.memberships) {
          if (m.userId === where.userId) {
            m.userEmail = data.userEmail;
            count++;
          }
        }
        return { count };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.calls.membershipCreateData.push(data);
        const row = {
          organizationId: data.organizationId as string,
          userId: data.userId as string,
          userEmail: data.userEmail as string,
          role: data.role as string,
          status: "active",
          createdAt: new Date(),
          ssoExempt: false,
          userName: null,
          userUpdatedAt: new Date(),
          userExternalAuthId: "scim-new",
        };
        state.memberships.push(row);
        return toMemberRecord(row);
      },
    },
  },
}));

vi.mock("./team-service", () => ({
  suspendMember: async (...args: unknown[]) => {
    teamCalls.suspend.push(args);
    if (teamCalls.suspendError) throw teamCalls.suspendError;
    return "disabled";
  },
  reinstateMember: async (...args: unknown[]) => {
    teamCalls.reinstate.push(args);
    return "enabled";
  },
}));

vi.mock("./group-service", () => ({
  createGroupCore: async (...args: unknown[]) => {
    groupCalls.create.push(args);
    return { id: "grp-1" };
  },
  renameGroupCore: async (...args: unknown[]) => {
    groupCalls.rename.push(args);
    return { id: "grp-1" };
  },
  deleteGroupCore: async (...args: unknown[]) => {
    groupCalls.del.push(args);
  },
  setGroupMembersCore: async (...args: unknown[]) => {
    groupCalls.setMembers.push(args);
    return { added: 0, removed: 0 };
  },
  addGroupMemberCore: async (...args: unknown[]) => {
    groupCalls.addMember.push(args);
    return { added: true };
  },
  removeGroupMemberCore: async (...args: unknown[]) => {
    groupCalls.removeMember.push(args);
    return { removed: true };
  },
}));

import {
  upsertUserByEmail,
  provisionMember,
  deactivateMember,
  reactivateMember,
  updateMemberProfile,
  renameMemberEmail,
  listMembersOffset,
  findMemberByEmail,
  findMemberByUserId,
  resolveScimActor,
  scimCreateGroup,
  scimSetGroupExternalId,
  scimSetGroupMembers,
  scimAddGroupMember,
} from "./org-directory-service";
import { ServiceError } from "../../services/errors";

const seedMembership = (
  over: Partial<(typeof state.memberships)[number]> = {},
) => {
  const row = {
    organizationId: "org-1",
    userId: "usr-1",
    userEmail: "a@x.com",
    role: "member",
    status: "active",
    createdAt: new Date("2026-01-01"),
    ssoExempt: false,
    userName: null,
    userUpdatedAt: new Date("2025-12-01"),
    userExternalAuthId: "sub-1",
    ...over,
  };
  state.memberships.push(row);
  return row;
};

beforeEach(() => {
  state.users = [];
  state.memberships = [];
  state.groups = [];
  state.apiKeys = [];
  state.failNextUserCreate = false;
  state.failNextEmailUpdate = false;
  state.failNextGroupUpdate = false;
  for (const key of Object.keys(state.calls) as (keyof typeof state.calls)[]) {
    state.calls[key] = [];
  }
  teamCalls.suspend = [];
  teamCalls.reinstate = [];
  teamCalls.suspendError = null;
  for (const key of Object.keys(groupCalls) as (keyof typeof groupCalls)[]) {
    groupCalls[key] = [];
  }
});

describe("upsertUserByEmail", () => {
  it("creates a new user with a scim- placeholder externalAuthId", async () => {
    const result = await upsertUserByEmail("New@X.com", "New Person");
    expect(result).toMatchObject({
      email: "new@x.com",
      name: "New Person",
      created: true,
    });
    const authId = state.calls.userCreateData[0]?.externalAuthId as string;
    expect(authId).toMatch(/^scim-[0-9a-f-]{36}$/);
  });

  it("returns the existing user without creating (case-insensitive)", async () => {
    state.users.push({
      id: "usr-1",
      email: "a@x.com",
      name: "A",
      externalAuthId: "sub-1",
    });
    const result = await upsertUserByEmail("  A@X.COM ");
    expect(result).toMatchObject({ userId: "usr-1", created: false });
    expect(state.calls.userCreateData).toHaveLength(0);
  });

  it("rejects non-email userNames", async () => {
    await expect(upsertUserByEmail("not-an-email")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("adopts the winner's row on a concurrent-create race (P2002)", async () => {
    state.failNextUserCreate = true;
    const result = await upsertUserByEmail("raced@x.com");
    expect(result).toMatchObject({ userId: "usr-winner", created: false });
  });
});

describe("provisionMember", () => {
  it("creates user + active member-role membership", async () => {
    const result = await provisionMember("org-1", "new@x.com", "New");
    expect(result).toMatchObject({
      email: "new@x.com",
      role: "member",
      status: "active",
      created: true,
    });
    expect(state.calls.membershipCreateData[0]).toMatchObject({
      organizationId: "org-1",
      userEmail: "new@x.com",
      role: "member",
    });
  });

  it("existing membership → created:false, no second row (the 409 path)", async () => {
    state.users.push({
      id: "usr-1",
      email: "a@x.com",
      name: null,
      externalAuthId: "sub-1",
    });
    seedMembership({ role: "admin", status: "suspended" });
    const result = await provisionMember("org-1", "a@x.com");
    expect(result).toMatchObject({
      created: false,
      role: "admin",
      status: "suspended",
    });
    expect(state.calls.membershipCreateData).toHaveLength(0);
  });
});

describe("deactivateMember / reactivateMember", () => {
  it("active member → dispatches team-service suspend", async () => {
    seedMembership();
    await deactivateMember("org-1", "usr-1", "actor-1");
    expect(teamCalls.suspend).toEqual([["org-1", "usr-1", "actor-1"]]);
  });

  it("already suspended → idempotent no-op (no CONFLICT)", async () => {
    seedMembership({ status: "suspended" });
    await expect(
      deactivateMember("org-1", "usr-1", "actor-1"),
    ).resolves.toBeUndefined();
    expect(teamCalls.suspend).toHaveLength(0);
  });

  it("rejects owner deactivation before dispatching (clear SCIM detail)", async () => {
    // The pre-check must fire before team-service's self-guard — the SCIM
    // actor IS the owner, so suspendMember would say "cannot suspend
    // yourself", which is nonsense in an IdP admin console.
    seedMembership({ role: "owner" });
    await expect(
      deactivateMember("org-1", "usr-1", "usr-1"),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("owner cannot be deactivated"),
    });
    expect(teamCalls.suspend).toHaveLength(0);
  });

  it("propagates team-service guards as ServiceError", async () => {
    seedMembership();
    teamCalls.suspendError = new ServiceError(
      "BAD_REQUEST",
      "You cannot suspend yourself",
    );
    await expect(
      deactivateMember("org-1", "usr-1", "usr-1"),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("unknown membership → NOT_FOUND", async () => {
    await expect(
      deactivateMember("org-1", "ghost", "actor-1"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reactivate dispatches reinstate only when suspended", async () => {
    seedMembership({ status: "suspended" });
    await reactivateMember("org-1", "usr-1");
    expect(teamCalls.reinstate).toEqual([["org-1", "usr-1"]]);

    state.memberships[0]!.status = "active";
    await expect(reactivateMember("org-1", "usr-1")).resolves.toBeUndefined();
    expect(teamCalls.reinstate).toHaveLength(1);
  });
});

describe("listMembersOffset", () => {
  it("translates 1-based startIndex to skip and returns the total", async () => {
    for (let i = 1; i <= 5; i++) {
      seedMembership({ userId: `usr-${i}`, userEmail: `u${i}@x.com` });
    }
    const page = await listMembersOffset("org-1", 3, 2);
    expect(page.totalResults).toBe(5);
    expect(page.members.map((m) => m.userId)).toEqual(["usr-3", "usr-4"]);
    expect(state.calls.memberFindManyArgs[0]).toMatchObject({
      skip: 2,
      take: 2,
    });
  });

  it("count:0 returns the total without querying rows", async () => {
    seedMembership();
    const page = await listMembersOffset("org-1", 1, 0);
    expect(page).toEqual({ members: [], totalResults: 1 });
    expect(state.calls.memberFindManyArgs).toHaveLength(0);
  });

  it("filters internal placeholder members", async () => {
    await listMembersOffset("org-1", 1, 10);
    expect(state.calls.memberCountWhere[0]).toMatchObject({
      NOT: { userEmail: { endsWith: "@onecli.internal" } },
    });
  });
});

describe("updateMemberProfile", () => {
  it("updates only after the cross-tenant membership check", async () => {
    state.users.push({
      id: "usr-1",
      email: "a@x.com",
      name: "Old",
      externalAuthId: "sub-1",
    });
    seedMembership();
    await updateMemberProfile("org-1", "usr-1", { displayName: "New Name" });
    expect(state.users[0]!.name).toBe("New Name");

    // not a member of org-2 → no write
    await expect(
      updateMemberProfile("org-2", "usr-1", { displayName: "Evil" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(state.calls.userUpdateData).toHaveLength(1);

    // an empty patch is a no-op, not an UPDATE with empty data
    await updateMemberProfile("org-1", "usr-1", {});
    expect(state.calls.userUpdateData).toHaveLength(1);
  });
});

describe("renameMemberEmail (SCIM userName change)", () => {
  const seedUser = (over: Partial<(typeof state.users)[number]> = {}) => {
    state.users.push({
      id: "usr-1",
      email: "a@x.com",
      name: null,
      externalAuthId: "sub-1",
      ...over,
    });
  };

  it("renames a sole-org member and syncs live denormalizations", async () => {
    seedUser({ externalAuthId: "scim-abc" });
    seedMembership({ userExternalAuthId: "scim-abc" });
    state.apiKeys.push({ userId: "usr-1", userEmail: "a@x.com" });
    const result = await renameMemberEmail("org-1", "usr-1", "  New@X.com ");
    expect(result).toEqual({ email: "new@x.com" });
    expect(state.users[0]!.email).toBe("new@x.com");
    expect(state.memberships[0]!.userEmail).toBe("new@x.com");
    expect(state.apiKeys[0]!.userEmail).toBe("new@x.com");
  });

  it("refuses multi-org users — even placeholders (a shared identity two IdPs provisioned)", async () => {
    seedUser({ externalAuthId: "scim-abc" });
    seedMembership({ userExternalAuthId: "scim-abc" });
    seedMembership({
      organizationId: "org-2",
      userExternalAuthId: "scim-abc",
    });
    await expect(
      renameMemberEmail("org-1", "usr-1", "renamed@x.com"),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("multiple organizations"),
    });
    expect(state.users[0]!.email).toBe("a@x.com");
    expect(state.memberships[1]!.userEmail).toBe("a@x.com");
  });

  it("same email is a no-op; collision maps to CONFLICT (409 uniqueness)", async () => {
    seedUser({ externalAuthId: "scim-abc" });
    seedMembership({ userExternalAuthId: "scim-abc" });
    await expect(
      renameMemberEmail("org-1", "usr-1", "A@X.com"),
    ).resolves.toEqual({ email: "a@x.com" });
    expect(state.calls.userUpdateData).toHaveLength(0);

    state.failNextEmailUpdate = true;
    await expect(
      renameMemberEmail("org-1", "usr-1", "taken@x.com"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("scimSetGroupExternalId", () => {
  it("updates org-scoped and maps P2002 to CONFLICT", async () => {
    state.groups.push({
      id: "grp-1",
      organizationId: "org-1",
      externalId: null,
    });
    await scimSetGroupExternalId("org-1", "grp-1", "ext-9");
    expect(state.groups[0]!.externalId).toBe("ext-9");

    await expect(
      scimSetGroupExternalId("org-2", "grp-1", "ext-9"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    state.failNextGroupUpdate = true;
    await expect(
      scimSetGroupExternalId("org-1", "grp-1", "dup"),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("externalId"),
    });
  });
});

describe("lastModifiedAt (SCIM meta.lastModified source)", () => {
  it("is the LATER of user.updatedAt and the membership's creation", async () => {
    // User row last touched BEFORE joining the org → joinedAt wins, so
    // lastModified never precedes created on the SCIM resource.
    seedMembership({ userUpdatedAt: new Date("2025-12-01") });
    const stale = await findMemberByUserId("org-1", "usr-1");
    expect(stale?.lastModifiedAt).toEqual(new Date("2026-01-01"));

    state.memberships[0]!.userUpdatedAt = new Date("2026-03-01");
    const fresh = await findMemberByUserId("org-1", "usr-1");
    expect(fresh?.lastModifiedAt).toEqual(new Date("2026-03-01"));
  });
});

describe("lookups", () => {
  it("findMemberByEmail normalizes and maps the TeamMember shape", async () => {
    seedMembership({ userName: "Alice" });
    const member = await findMemberByEmail("org-1", "  A@X.COM ");
    expect(member).toMatchObject({
      userId: "usr-1",
      email: "a@x.com",
      name: "Alice",
      role: "member",
      status: "active",
    });
  });

  it("resolveScimActor returns the owner and fails loud without one", async () => {
    seedMembership({ userId: "usr-9", userEmail: "own@x.com", role: "owner" });
    expect(await resolveScimActor("org-1")).toEqual({
      userId: "usr-9",
      userEmail: "own@x.com",
    });
    await expect(resolveScimActor("org-2")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("scim group wrappers", () => {
  it("pass through with scim source, externalId, and a null actor", async () => {
    await scimCreateGroup("org-1", "Engineering", "ext-42");
    expect(groupCalls.create).toEqual([
      ["org-1", "Engineering", "scim", "ext-42"],
    ]);

    await scimSetGroupMembers("org-1", "grp-1", ["u1", "u2"]);
    expect(groupCalls.setMembers).toEqual([
      ["org-1", "grp-1", ["u1", "u2"], null],
    ]);

    await scimAddGroupMember("org-1", "grp-1", "u1");
    expect(groupCalls.addMember).toEqual([["org-1", "grp-1", "u1", null]]);
  });
});
