import { beforeEach, describe, expect, it, vi } from "vitest";

// Service-level tests over a hand-rolled db mock: tenant isolation on every
// query, the SCIM-managed lock, idempotent membership ops (P2002 handled via
// a real error class so the instanceof path is exercised), the replace-set
// transaction shape, and keyset pagination.

const state = vi.hoisted(() => ({
  groups: [] as {
    id: string;
    organizationId: string;
    name: string;
    source: string;
    externalId: string | null;
    createdAt: Date;
    updatedAt: Date;
    memberCount: number;
  }[],
  orgMembers: [] as { organizationId: string; userId: string }[],
  groupMembers: [] as { groupId: string; userId: string; createdAt: Date }[],
  calls: {
    groupFindFirstWhere: [] as unknown[],
    groupFindManyWhere: [] as unknown[],
    memberCreateData: [] as unknown[],
    transactionOps: [] as unknown[],
    deleteManyWhere: [] as unknown[],
    createManyArgs: [] as unknown[],
  },
  failNextCreateWithDuplicate: false,
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

const toRecord = (g: (typeof state.groups)[number]) => ({
  id: g.id,
  name: g.name,
  source: g.source,
  externalId: g.externalId,
  createdAt: g.createdAt,
  updatedAt: g.updatedAt,
  _count: { members: g.memberCount },
});

vi.mock("@onecli/db", () => ({
  Prisma: { PrismaClientKnownRequestError: MockPrismaKnownError },
  db: {
    group: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        state.calls.groupFindFirstWhere.push(where);
        const found = state.groups.find(
          (g) => g.id === where.id && g.organizationId === where.organizationId,
        );
        return found ? toRecord(found) : null;
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        state.calls.groupFindManyWhere.push(where);
        return state.groups
          .filter((g) => g.organizationId === where.organizationId)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(toRecord);
      },
      create: async ({
        data,
      }: {
        data: { organizationId: string; name: string; source: string };
      }) => {
        if (state.failNextCreateWithDuplicate) {
          state.failNextCreateWithDuplicate = false;
          throw new MockPrismaKnownError("P2002");
        }
        const row = {
          id: `grp-${state.groups.length + 1}`,
          organizationId: data.organizationId,
          name: data.name,
          source: data.source,
          externalId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          memberCount: 0,
        };
        state.groups.push(row);
        return toRecord(row);
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { name: string };
      }) => {
        const g = state.groups.find((x) => x.id === where.id);
        if (!g) throw new MockPrismaKnownError("P2025");
        g.name = data.name;
        return toRecord(g);
      },
      delete: async ({ where }: { where: { id: string } }) => {
        state.groups = state.groups.filter((g) => g.id !== where.id);
        return {};
      },
    },
    groupMember: {
      findMany: async ({ where }: { where: { groupId: string } }) =>
        state.groupMembers
          .filter((m) => m.groupId === where.groupId)
          .map((m) => ({
            ...m,
            user: { email: `${m.userId}@x.com`, name: null },
          })),
      create: async ({
        data,
      }: {
        data: { groupId: string; userId: string };
      }) => {
        state.calls.memberCreateData.push(data);
        if (
          state.groupMembers.some(
            (m) => m.groupId === data.groupId && m.userId === data.userId,
          )
        ) {
          throw new MockPrismaKnownError("P2002");
        }
        state.groupMembers.push({ ...data, createdAt: new Date() });
        return {};
      },
      deleteMany: async ({
        where,
      }: {
        where: { groupId: string; userId: string | { in: string[] } };
      }) => {
        state.calls.deleteManyWhere.push(where);
        const targets =
          typeof where.userId === "string" ? [where.userId] : where.userId.in;
        const before = state.groupMembers.length;
        state.groupMembers = state.groupMembers.filter(
          (m) => !(m.groupId === where.groupId && targets.includes(m.userId)),
        );
        return { count: before - state.groupMembers.length };
      },
      createMany: async (args: {
        data: { groupId: string; userId: string }[];
        skipDuplicates: boolean;
      }) => {
        state.calls.createManyArgs.push(args);
        for (const row of args.data) {
          state.groupMembers.push({ ...row, createdAt: new Date() });
        }
        return { count: args.data.length };
      },
    },
    organizationMember: {
      findUnique: async ({
        where,
      }: {
        where: {
          organizationId_userId: { organizationId: string; userId: string };
        };
      }) =>
        state.orgMembers.find(
          (m) =>
            m.organizationId === where.organizationId_userId.organizationId &&
            m.userId === where.organizationId_userId.userId,
        ) ?? null,
      findMany: async ({
        where,
      }: {
        where: { organizationId: string; userId: { in: string[] } };
      }) =>
        state.orgMembers.filter(
          (m) =>
            m.organizationId === where.organizationId &&
            where.userId.in.includes(m.userId),
        ),
    },
    $transaction: async (ops: unknown[]) => {
      state.calls.transactionOps.push(ops);
      return Promise.all(ops as Promise<unknown>[]);
    },
  },
}));

// Isolate these unit tests from the real role applier (it lives in team-service
// and is invoked by the membership *Core fns since step 15). Mocking it also
// lets us assert the reconcile wiring.
const teamService = vi.hoisted(() => ({ reconcileMemberRoles: vi.fn() }));
vi.mock("./team-service", () => teamService);

import {
  createGroup,
  renameGroup,
  deleteGroup,
  addGroupMember,
  removeGroupMember,
  setGroupMembers,
  listGroups,
} from "./group-service";
import { ServiceError } from "../../services/errors";

const seedGroup = (over: Partial<(typeof state.groups)[number]> = {}) => {
  const row = {
    id: "grp-1",
    organizationId: "org-1",
    name: "HR",
    source: "manual",
    externalId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    memberCount: 0,
    ...over,
  };
  state.groups.push(row);
  return row;
};

beforeEach(() => {
  state.groups = [];
  state.orgMembers = [{ organizationId: "org-1", userId: "u1" }];
  state.groupMembers = [];
  state.failNextCreateWithDuplicate = false;
  for (const key of Object.keys(state.calls) as (keyof typeof state.calls)[]) {
    state.calls[key] = [];
  }
  teamService.reconcileMemberRoles.mockClear();
});

describe("role-mapping reconcile wiring (step 15)", () => {
  it("deleting a group reconciles its members from a pre-cascade snapshot", async () => {
    seedGroup(); // grp-1, source "manual"
    state.groupMembers = [
      { groupId: "grp-1", userId: "u1", createdAt: new Date() },
      { groupId: "grp-1", userId: "u2", createdAt: new Date() },
    ];

    await deleteGroup("org-1", "grp-1");

    // Members snapshotted BEFORE the cascade, reconciled AFTER the delete,
    // attributed to a manual (API) edit.
    expect(teamService.reconcileMemberRoles).toHaveBeenCalledWith(
      "org-1",
      ["u1", "u2"],
      "api",
    );
  });

  it("a membership add reconciles the affected user", async () => {
    seedGroup();
    await addGroupMember("org-1", "grp-1", "u1", "actor-1");
    expect(teamService.reconcileMemberRoles).toHaveBeenCalledWith(
      "org-1",
      ["u1"],
      "api",
    );
  });
});

describe("tenant isolation", () => {
  it("cross-org group ids resolve to NOT_FOUND", async () => {
    seedGroup({ organizationId: "org-OTHER" });
    await expect(renameGroup("org-1", "grp-1", "X")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // the lookup carried the tenant key, not just the row id
    expect(state.calls.groupFindFirstWhere[0]).toMatchObject({
      id: "grp-1",
      organizationId: "org-1",
    });
  });

  it("listGroups always scopes by organizationId", async () => {
    await listGroups("org-1");
    expect(state.calls.groupFindManyWhere[0]).toMatchObject({
      organizationId: "org-1",
    });
  });
});

describe("SCIM-managed lock", () => {
  it.each([
    ["rename", () => renameGroup("org-1", "grp-1", "X")],
    ["delete", () => deleteGroup("org-1", "grp-1")],
    ["add member", () => addGroupMember("org-1", "grp-1", "u1", "actor")],
    ["remove member", () => removeGroupMember("org-1", "grp-1", "u1")],
    ["set members", () => setGroupMembers("org-1", "grp-1", ["u1"], "actor")],
  ])("%s → CONFLICT on scim groups", async (_label, run) => {
    seedGroup({ source: "scim" });
    await expect(run()).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("create", () => {
  it("always creates manual-source groups and maps P2002 to CONFLICT", async () => {
    const created = await createGroup("org-1", "HR");
    expect(created.source).toBe("manual");

    state.failNextCreateWithDuplicate = true;
    await expect(createGroup("org-1", "HR")).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("membership ops", () => {
  it("add is idempotent (duplicate → added:false, no throw)", async () => {
    seedGroup();
    expect(await addGroupMember("org-1", "grp-1", "u1", "actor")).toEqual({
      added: true,
    });
    expect(await addGroupMember("org-1", "grp-1", "u1", "actor")).toEqual({
      added: false,
    });
  });

  it("add rejects non-members of the org", async () => {
    seedGroup();
    await expect(
      addGroupMember("org-1", "grp-1", "stranger", "actor"),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("add records the acting user on the row", async () => {
    seedGroup();
    await addGroupMember("org-1", "grp-1", "u1", "actor");
    expect(state.calls.memberCreateData[0]).toMatchObject({
      createdByUserId: "actor",
    });
  });

  it("remove is idempotent (absent → removed:false)", async () => {
    seedGroup();
    expect(await removeGroupMember("org-1", "grp-1", "u1")).toEqual({
      removed: false,
    });
  });

  it("replace-set diffs, validates ids, and runs one transaction", async () => {
    seedGroup();
    state.orgMembers.push({ organizationId: "org-1", userId: "u2" });
    state.groupMembers.push({
      groupId: "grp-1",
      userId: "u1",
      createdAt: new Date(),
    });

    const result = await setGroupMembers("org-1", "grp-1", ["u2"], "actor");
    expect(result).toEqual({ added: 1, removed: 1 });
    expect(state.calls.transactionOps).toHaveLength(1);
    expect(state.calls.createManyArgs[0]).toMatchObject({
      skipDuplicates: true,
    });

    // unknown ids fail closed before any write
    await expect(
      setGroupMembers("org-1", "grp-1", ["ghost"], "actor"),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(state.calls.transactionOps).toHaveLength(1);

    // no-op diff short-circuits without a transaction
    const noop = await setGroupMembers("org-1", "grp-1", ["u2"], "actor");
    expect(noop).toEqual({ added: 0, removed: 0 });
    expect(state.calls.transactionOps).toHaveLength(1);
  });
});

describe("pagination plumbing", () => {
  it("rejects malformed cursors as BAD_REQUEST", async () => {
    await expect(
      listGroups("org-1", { cursor: "garbage!" }),
    ).rejects.toThrowError(ServiceError);
  });
});
