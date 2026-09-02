import { beforeEach, describe, expect, it, vi } from "vitest";

// The resolution core of step 15: which org role a member gets from their
// group→role mappings. resolveWinningRole is pure; resolveRolesForUsers and
// isRoleManagedByIdp run over a hand-rolled db mock (the service has no other
// dependencies).

const state = vi.hoisted(() => ({
  // Rows returned by groupMember.findMany for resolveRolesForUsers — each is a
  // (userId, its group's roleMapping) pair.
  mapped: [] as { userId: string; role: string; priority: number }[],
  mappingCount: 0,
  // Preview fixtures.
  previewExisting: null as { priority: number } | null,
  previewAggMin: null as number | null,
  previewTarget: [] as { userId: string }[],
  previewMembers: [] as { userId: string; role: string }[],
}));

vi.mock("@onecli/db", () => ({
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
  db: {
    groupMember: {
      findMany: async ({ where }: { where: { groupId?: string } }) => {
        // The preview's "target group members" query keys off a concrete
        // groupId; every other findMany here is the (userId → roleMapping) shape.
        if (typeof where?.groupId === "string") return state.previewTarget;
        return state.mapped.map((m) => ({
          userId: m.userId,
          group: { roleMapping: { role: m.role, priority: m.priority } },
        }));
      },
    },
    groupRoleMapping: {
      count: async () => state.mappingCount,
      findFirst: async () => state.previewExisting,
      aggregate: async () => ({ _min: { priority: state.previewAggMin } }),
    },
    organizationMember: {
      findMany: async () => state.previewMembers,
    },
  },
}));

import {
  resolveWinningRole,
  resolveRolesForUsers,
  isRoleManagedByIdp,
  previewRoleMappingImpact,
} from "./role-mapping-service";

beforeEach(() => {
  state.mapped = [];
  state.mappingCount = 0;
  state.previewExisting = null;
  state.previewAggMin = null;
  state.previewTarget = [];
  state.previewMembers = [];
});

describe("resolveWinningRole", () => {
  it("returns null when the user is in no mapped group (unmatched → keep role)", () => {
    expect(resolveWinningRole([])).toBeNull();
  });

  it("picks the single mapping's role", () => {
    expect(resolveWinningRole([{ role: "admin", priority: 1 }])).toBe("admin");
    expect(resolveWinningRole([{ role: "member", priority: 1 }])).toBe(
      "member",
    );
  });

  it("the highest priority wins across multiple mapped groups", () => {
    expect(
      resolveWinningRole([
        { role: "member", priority: 10 },
        { role: "admin", priority: 5 },
      ]),
    ).toBe("member");
    expect(
      resolveWinningRole([
        { role: "member", priority: 5 },
        { role: "admin", priority: 10 },
      ]),
    ).toBe("admin");
  });

  it("breaks a priority tie in favor of admin (never silently demote)", () => {
    expect(
      resolveWinningRole([
        { role: "member", priority: 3 },
        { role: "admin", priority: 3 },
      ]),
    ).toBe("admin");
    // Order-independent.
    expect(
      resolveWinningRole([
        { role: "admin", priority: 3 },
        { role: "member", priority: 3 },
      ]),
    ).toBe("admin");
  });

  it("normalizes any non-admin role to member", () => {
    expect(resolveWinningRole([{ role: "weird", priority: 1 }])).toBe("member");
  });
});

describe("resolveRolesForUsers", () => {
  it("maps each user to their winning role and omits the unmatched", async () => {
    state.mapped = [
      { userId: "u1", role: "admin", priority: 2 },
      { userId: "u1", role: "member", priority: 1 },
      { userId: "u2", role: "member", priority: 5 },
      // u3 is requested but appears in no mapped group.
    ];
    const result = await resolveRolesForUsers("org-1", ["u1", "u2", "u3"]);
    expect(result.get("u1")).toBe("admin"); // priority 2 beats 1
    expect(result.get("u2")).toBe("member");
    // Unmatched users are absent — the applier leaves their role untouched.
    expect(result.has("u3")).toBe(false);
  });

  it("returns an empty map for an empty user list", async () => {
    expect((await resolveRolesForUsers("org-1", [])).size).toBe(0);
  });
});

describe("isRoleManagedByIdp", () => {
  it("is true when a mapping covers a group the member belongs to", async () => {
    state.mappingCount = 1;
    expect(await isRoleManagedByIdp("org-1", "u1")).toBe(true);
  });

  it("is false when no mapping covers the member", async () => {
    state.mappingCount = 0;
    expect(await isRoleManagedByIdp("org-1", "u1")).toBe(false);
  });
});

describe("previewRoleMappingImpact", () => {
  it("counts members whose role would change, under the server-computed priority", async () => {
    // A brand-new mapping (no existing row → lowest priority) on a group whose
    // one member is a plain member with no other mapped group.
    state.previewExisting = null;
    state.previewAggMin = null; // → nextLowestPriority = 0
    state.previewTarget = [{ userId: "u1" }];
    state.previewMembers = [{ userId: "u1", role: "member" }];
    state.mapped = []; // no OTHER mapped groups for u1

    const result = await previewRoleMappingImpact("org-1", {
      groupId: "g1",
      role: "admin",
    });
    expect(result.affectedCount).toBe(1); // member → admin
  });

  it("counts zero when the proposed role already matches the members' role", async () => {
    state.previewTarget = [{ userId: "u1" }];
    state.previewMembers = [{ userId: "u1", role: "member" }];
    state.mapped = [];

    const result = await previewRoleMappingImpact("org-1", {
      groupId: "g1",
      role: "member",
    });
    expect(result.affectedCount).toBe(0);
  });
});
