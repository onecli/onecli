import { beforeEach, describe, expect, it, vi } from "vitest";

interface MockPaRow {
  id?: string;
  userId: string | null;
  groupId: string | null;
  role?: string;
  createdAt?: Date;
  user?: { name: string | null; email: string } | null;
  group?: { name: string; _count: { members: number } } | null;
}

const state = vi.hoisted(() => ({
  workspace: null as { id: string; createdByUserId: string | null } | null,
  paRows: [] as MockPaRow[],
  validMembers: [] as { userId: string }[],
  validGroups: [] as { id: string }[],
  deleteWheres: [] as Record<string, unknown>[],
  updateOps: [] as {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }[],
  createData: [] as Record<string, unknown>[][],
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    workspace: { findFirst: async () => state.workspace },
    workspaceAccess: {
      findMany: async () => state.paRows,
      deleteMany: async (args: { where: Record<string, unknown> }) => {
        state.deleteWheres.push(args.where);
        return { count: 0 };
      },
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        state.updateOps.push({ where: args.where, data: args.data });
        return { count: 0 };
      },
      createMany: async (args: { data: Record<string, unknown>[] }) => {
        state.createData.push(args.data);
        return { count: args.data.length };
      },
    },
    organizationMember: { findMany: async () => state.validMembers },
    group: { findMany: async () => state.validGroups },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));

import {
  listWorkspaceAccess,
  replaceWorkspaceAccess,
} from "./workspace-access-service";

const D = new Date("2026-01-01T00:00:00.000Z");

beforeEach(() => {
  state.workspace = { id: "p1", createdByUserId: "owner" };
  state.paRows = [];
  state.validMembers = [];
  state.validGroups = [];
  state.deleteWheres = [];
  state.updateOps = [];
  state.createData = [];
});

describe("listWorkspaceAccess", () => {
  it("returns each user's role, flags the creator, and drops placeholders", async () => {
    state.paRows = [
      {
        id: "r1",
        userId: "owner",
        groupId: null,
        role: "owner",
        createdAt: D,
        user: { name: "Owner", email: "owner@acme.com" },
        group: null,
      },
      {
        id: "r2",
        userId: "u2",
        groupId: null,
        role: "member",
        createdAt: D,
        user: { name: null, email: "u2@acme.com" },
        group: null,
      },
      {
        id: "r3",
        userId: "placeholder",
        groupId: null,
        role: "member",
        createdAt: D,
        user: { name: null, email: "provision-abc@onecli.internal" },
        group: null,
      },
      {
        id: "r4",
        userId: null,
        groupId: "g1",
        role: "member",
        createdAt: D,
        user: null,
        group: { name: "Engineering", _count: { members: 3 } },
      },
    ];

    const result = await listWorkspaceAccess("org-1", "p1");

    expect(result.users.map((u) => u.userId)).toEqual(["owner", "u2"]);
    const owner = result.users.find((u) => u.userId === "owner");
    const u2 = result.users.find((u) => u.userId === "u2");
    expect(owner?.role).toBe("owner");
    expect(owner?.isOwner).toBe(true); // creator provenance, distinct from role
    expect(u2?.role).toBe("member");
    expect(u2?.isOwner).toBe(false);
    expect(result.groups).toEqual([
      {
        id: "r4",
        groupId: "g1",
        name: "Engineering",
        memberCount: 3,
        createdAt: D,
      },
    ]);
  });

  it("reads any non-'owner' role value as member (least privilege)", async () => {
    state.paRows = [
      {
        id: "r1",
        userId: "u2",
        groupId: null,
        role: "weird", // a stray/legacy value must never read as owner
        createdAt: D,
        user: { name: null, email: "u2@acme.com" },
        group: null,
      },
    ];
    const result = await listWorkspaceAccess("org-1", "p1");
    expect(result.users[0]?.role).toBe("member");
  });

  it("throws NOT_FOUND when the workspace isn't in the org", async () => {
    state.workspace = null;
    await expect(listWorkspaceAccess("org-1", "p1")).rejects.toThrow(
      /not found/i,
    );
  });
});

describe("replaceWorkspaceAccess", () => {
  it("adds a share (with its role) and removes every omitted user — the creator included", async () => {
    state.validMembers = [{ userId: "u2" }];
    state.paRows = [
      { userId: "owner", groupId: null, role: "owner" },
      { userId: "u3", groupId: null, role: "member" },
    ];

    const result = await replaceWorkspaceAccess(
      "org-1",
      "p1",
      { users: [{ userId: "u2", role: "member" }], groupIds: [] },
      "actor",
    );

    // owner and u3 are both omitted, so both are removed (no owner-protection).
    expect(result).toEqual({ added: 1, removed: 2, roleChanged: 0 });
    expect(state.createData.flat()).toEqual([
      {
        workspaceId: "p1",
        userId: "u2",
        role: "member",
        createdByUserId: "actor",
      },
    ]);
    const deletedUsers = state.deleteWheres.flatMap((w) =>
      Array.isArray((w.userId as { in?: string[] })?.in)
        ? (w.userId as { in: string[] }).in
        : [],
    );
    expect(deletedUsers).toEqual(expect.arrayContaining(["owner", "u3"]));
  });

  it("adds a user directly as owner — the role travels with the principal", async () => {
    state.validMembers = [{ userId: "u2" }];
    state.paRows = [{ userId: "owner", groupId: null, role: "owner" }];

    const result = await replaceWorkspaceAccess(
      "org-1",
      "p1",
      {
        users: [
          { userId: "owner", role: "owner" },
          { userId: "u2", role: "owner" },
        ],
        groupIds: [],
      },
      "actor",
    );

    expect(result).toEqual({ added: 1, removed: 0, roleChanged: 0 });
    expect(state.createData.flat()).toEqual([
      {
        workspaceId: "p1",
        userId: "u2",
        role: "owner",
        createdByUserId: "actor",
      },
    ]);
  });

  it("promotes a preserved member to owner via updateMany (no re-create)", async () => {
    state.paRows = [
      { userId: "owner", groupId: null, role: "owner" },
      { userId: "u2", groupId: null, role: "member" },
    ];

    const result = await replaceWorkspaceAccess(
      "org-1",
      "p1",
      {
        users: [
          { userId: "owner", role: "owner" },
          { userId: "u2", role: "owner" },
        ],
        groupIds: [],
      },
      "actor",
    );

    expect(result).toEqual({ added: 0, removed: 0, roleChanged: 1 });
    expect(state.updateOps).toContainEqual({
      where: { workspaceId: "p1", userId: { in: ["u2"] } },
      data: { role: "owner" },
    });
    expect(state.createData).toHaveLength(0);
    expect(state.deleteWheres).toHaveLength(0);
  });

  it("demotes a preserved owner to member via updateMany", async () => {
    state.paRows = [
      { userId: "owner", groupId: null, role: "owner" },
      { userId: "u2", groupId: null, role: "owner" },
    ];

    const result = await replaceWorkspaceAccess(
      "org-1",
      "p1",
      {
        users: [
          { userId: "owner", role: "owner" },
          { userId: "u2", role: "member" },
        ],
        groupIds: [],
      },
      "actor",
    );

    expect(result).toEqual({ added: 0, removed: 0, roleChanged: 1 });
    expect(state.updateOps).toContainEqual({
      where: { workspaceId: "p1", userId: { in: ["u2"] } },
      data: { role: "member" },
    });
  });

  it("removes the creator's binding when omitted — the last-binding guard is soft", async () => {
    // An empty payload removes the creator too, leaving the workspace reachable
    // only by org admins. The server allows it (the UI warns).
    state.paRows = [{ userId: "owner", groupId: null, role: "owner" }];

    const result = await replaceWorkspaceAccess(
      "org-1",
      "p1",
      { users: [], groupIds: [] },
      "actor",
    );

    expect(result).toEqual({ added: 0, removed: 1, roleChanged: 0 });
    expect(state.deleteWheres).toContainEqual({
      workspaceId: "p1",
      userId: { in: ["owner"] },
    });
  });

  it("rejects a userId that isn't an active member", async () => {
    state.validMembers = []; // u2 is not an active member
    await expect(
      replaceWorkspaceAccess(
        "org-1",
        "p1",
        { users: [{ userId: "u2", role: "member" }], groupIds: [] },
        "actor",
      ),
    ).rejects.toThrow(/not active members/i);
  });

  it("rejects a groupId that isn't in the org", async () => {
    state.validGroups = []; // g1 is not an org group
    await expect(
      replaceWorkspaceAccess(
        "org-1",
        "p1",
        { users: [], groupIds: ["g1"] },
        "actor",
      ),
    ).rejects.toThrow(/groups not in this organization/i);
  });

  it("validates only additions — a preserved but now-suspended member never blocks the edit", async () => {
    state.validMembers = [{ userId: "u-new" }];
    state.paRows = [
      { userId: "owner", groupId: null, role: "owner" },
      { userId: "u-kept", groupId: null, role: "member" },
    ];

    const result = await replaceWorkspaceAccess(
      "org-1",
      "p1",
      {
        users: [
          { userId: "owner", role: "owner" },
          { userId: "u-kept", role: "member" },
          { userId: "u-new", role: "member" },
        ],
        groupIds: [],
      },
      "actor",
    );

    expect(result).toEqual({ added: 1, removed: 0, roleChanged: 0 });
    // Only the new member is created; the suspended-but-preserved member is
    // neither re-created nor removed.
    expect(state.createData.flat()).toEqual([
      {
        workspaceId: "p1",
        userId: "u-new",
        role: "member",
        createdByUserId: "actor",
      },
    ]);
    expect(state.deleteWheres).toHaveLength(0);
  });

  it("still rejects a brand-new member who isn't active, even beside preserved shares", async () => {
    state.validMembers = []; // u-bogus is not an active member
    state.paRows = [
      { userId: "owner", groupId: null, role: "owner" },
      { userId: "u-kept", groupId: null, role: "member" },
    ];

    await expect(
      replaceWorkspaceAccess(
        "org-1",
        "p1",
        {
          users: [
            { userId: "u-kept", role: "member" },
            { userId: "u-bogus", role: "member" },
          ],
          groupIds: [],
        },
        "actor",
      ),
    ).rejects.toThrow(/not active members/i);
    expect(state.createData).toHaveLength(0);
  });

  it("is a no-op when the shares AND roles already match", async () => {
    state.validMembers = [{ userId: "u2" }];
    state.paRows = [
      { userId: "owner", groupId: null, role: "owner" },
      { userId: "u2", groupId: null, role: "member" },
    ];

    const result = await replaceWorkspaceAccess(
      "org-1",
      "p1",
      {
        users: [
          { userId: "owner", role: "owner" },
          { userId: "u2", role: "member" },
        ],
        groupIds: [],
      },
      "actor",
    );

    expect(result).toEqual({ added: 0, removed: 0, roleChanged: 0 });
    expect(state.deleteWheres).toHaveLength(0);
    expect(state.updateOps).toHaveLength(0);
    expect(state.createData).toHaveLength(0);
  });

  it("adds a group binding (groups carry no role)", async () => {
    state.validGroups = [{ id: "g1" }];
    state.paRows = [{ userId: "owner", groupId: null, role: "owner" }];

    const result = await replaceWorkspaceAccess(
      "org-1",
      "p1",
      { users: [{ userId: "owner", role: "owner" }], groupIds: ["g1"] },
      "actor",
    );

    expect(result).toEqual({ added: 1, removed: 0, roleChanged: 0 });
    expect(state.createData.flat()).toEqual([
      { workspaceId: "p1", groupId: "g1", createdByUserId: "actor" },
    ]);
  });

  it("removes a stale group binding", async () => {
    state.paRows = [
      { userId: "owner", groupId: null, role: "owner" },
      { userId: null, groupId: "g1", role: "member" },
    ];

    const result = await replaceWorkspaceAccess(
      "org-1",
      "p1",
      { users: [{ userId: "owner", role: "owner" }], groupIds: [] },
      "actor",
    );

    expect(result).toEqual({ added: 0, removed: 1, roleChanged: 0 });
    expect(state.deleteWheres).toContainEqual({
      workspaceId: "p1",
      groupId: { in: ["g1"] },
    });
    expect(state.createData).toHaveLength(0);
  });

  describe("plan gates fire on additions only", () => {
    it("skips both gates when the request only preserves existing bindings", async () => {
      state.validMembers = [{ userId: "u2" }];
      state.validGroups = [{ id: "g1" }];
      state.paRows = [
        { userId: "owner", groupId: null, role: "owner" },
        { userId: "u2", groupId: null, role: "member" },
        { userId: null, groupId: "g1", role: "member" },
      ];
      const assertCanAddUsers = vi.fn(async () => {});
      const assertCanAddGroups = vi.fn(async () => {});

      await replaceWorkspaceAccess(
        "org-1",
        "p1",
        {
          users: [
            { userId: "owner", role: "owner" },
            { userId: "u2", role: "member" },
          ],
          groupIds: ["g1"],
        },
        "actor",
        { assertCanAddUsers, assertCanAddGroups },
      );

      expect(assertCanAddUsers).not.toHaveBeenCalled();
      expect(assertCanAddGroups).not.toHaveBeenCalled();
    });

    it("does not require an entitlement to re-role an existing share", async () => {
      state.paRows = [
        { userId: "owner", groupId: null, role: "owner" },
        { userId: "u2", groupId: null, role: "member" },
      ];
      const assertCanAddUsers = vi.fn(async () => {});

      // Promote u2 to owner — a role change, not an addition — so no gate fires.
      await replaceWorkspaceAccess(
        "org-1",
        "p1",
        {
          users: [
            { userId: "owner", role: "owner" },
            { userId: "u2", role: "owner" },
          ],
          groupIds: [],
        },
        "actor",
        { assertCanAddUsers },
      );

      expect(assertCanAddUsers).not.toHaveBeenCalled();
      expect(state.updateOps).toHaveLength(1);
    });

    it("asserts each gate only for its newly added principal kind", async () => {
      state.validMembers = [{ userId: "u2" }];
      state.validGroups = [{ id: "g1" }, { id: "g2" }];
      state.paRows = [
        { userId: "owner", groupId: null, role: "owner" },
        { userId: null, groupId: "g1", role: "member" },
      ];
      const assertCanAddUsers = vi.fn(async () => {});
      const assertCanAddGroups = vi.fn(async () => {});

      // Preserve owner + g1, add u2 (new user) and g2 (new group).
      await replaceWorkspaceAccess(
        "org-1",
        "p1",
        {
          users: [
            { userId: "owner", role: "owner" },
            { userId: "u2", role: "member" },
          ],
          groupIds: ["g1", "g2"],
        },
        "actor",
        { assertCanAddUsers, assertCanAddGroups },
      );

      expect(assertCanAddUsers).toHaveBeenCalledTimes(1);
      expect(assertCanAddGroups).toHaveBeenCalledTimes(1);
    });

    it("propagates a gate rejection and writes nothing", async () => {
      state.validGroups = [{ id: "g1" }];
      state.paRows = [{ userId: "owner", groupId: null, role: "owner" }];

      await expect(
        replaceWorkspaceAccess(
          "org-1",
          "p1",
          { users: [], groupIds: ["g1"] },
          "actor",
          {
            assertCanAddGroups: async () => {
              throw new Error("enterprise required");
            },
          },
        ),
      ).rejects.toThrow("enterprise required");
      expect(state.createData).toHaveLength(0);
    });
  });
});
