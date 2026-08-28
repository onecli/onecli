import { beforeEach, describe, expect, it, vi } from "vitest";

// canManageAllWorkspaces (used by the workspace checks) only scopes by role under
// RBAC — pin the cloud edition so the role arm is exercised.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

const state = vi.hoisted(() => ({
  membership: null as { role: string; status: string } | null,
  workspace: null as {
    createdByUserId: string | null;
    organizationId: string;
  } | null,
  // Usage binding (hasWorkspaceAccessBinding) vs owner-role binding
  // (hasWorkspaceOwnerBinding, step 13c). The mock routes findFirst by the `role`
  // filter so the two are controlled independently.
  binding: null as { id: string } | null,
  ownerBinding: null as { id: string } | null,
  workspaceProbes: [] as Record<string, unknown>[],
  bindingProbes: [] as Record<string, unknown>[],
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    organizationMember: {
      findUnique: async () => state.membership,
    },
    workspace: {
      findFirst: async (args: Record<string, unknown>) => {
        state.workspaceProbes.push(args);
        return state.workspace;
      },
    },
    workspaceAccess: {
      findFirst: async (args: { where?: { role?: string } }) => {
        state.bindingProbes.push(args);
        return args?.where?.role === "owner"
          ? state.ownerBinding
          : state.binding;
      },
    },
  },
}));

import {
  eeWorkspaceAccessChecker,
  getUserRole,
  hasMinimumRole,
  hasWorkspaceAccessBinding,
  hasWorkspaceOwnerBinding,
  visibleWorkspacesWhere,
  canAccessWorkspace,
  canManageWorkspace,
} from "./authorization-service";

// hasMinimumRole is the role-hierarchy threshold the org admin/owner-only
// lockdown depends on: requireRole (server actions + route guards) and the API
// auth middleware both deny when a role falls below the required minimum. These
// cases pin the member -> denied / admin & owner -> allowed decision.
describe("hasMinimumRole", () => {
  it("grants when the role exceeds the threshold (owner >= admin)", () => {
    expect(hasMinimumRole("owner", "admin")).toBe(true);
  });

  it("grants when the role exactly meets the threshold (admin >= admin)", () => {
    expect(hasMinimumRole("admin", "admin")).toBe(true);
  });

  it("denies a member against the admin threshold", () => {
    expect(hasMinimumRole("member", "admin")).toBe(false);
  });

  it("denies a non-member (null role) against any threshold", () => {
    expect(hasMinimumRole(null, "admin")).toBe(false);
    expect(hasMinimumRole(null, "member")).toBe(false);
  });

  it("grants any role at or above its own level for the member threshold", () => {
    expect(hasMinimumRole("member", "member")).toBe(true);
    expect(hasMinimumRole("admin", "member")).toBe(true);
    expect(hasMinimumRole("owner", "member")).toBe(true);
  });

  it("reserves the owner threshold for owners only", () => {
    expect(hasMinimumRole("owner", "owner")).toBe(true);
    expect(hasMinimumRole("admin", "owner")).toBe(false);
    expect(hasMinimumRole("member", "owner")).toBe(false);
  });
});

// getUserRole is THE suspension choke point: a suspended membership must read
// as non-member (null) so every role gate, the org-key re-check, and the
// workspace-key re-check deny in one place.
describe("getUserRole suspension filter", () => {
  beforeEach(() => {
    state.membership = null;
  });

  it("returns the role of an active membership", async () => {
    state.membership = { role: "admin", status: "active" };
    await expect(getUserRole("u1", "org-1")).resolves.toBe("admin");
  });

  it("returns null for a suspended membership — any role, even owner", async () => {
    state.membership = { role: "owner", status: "suspended" };
    await expect(getUserRole("u1", "org-1")).resolves.toBeNull();
  });

  it("returns null for non-members", async () => {
    await expect(getUserRole("u1", "org-1")).resolves.toBeNull();
  });
});

// Step 13b: usage flipped to bindings-only — the creator arm was dropped, so a
// member sees ONLY the workspaces shared with them (direct or via a group).
// Admins/owners still see every workspace in the org.
describe("visibleWorkspacesWhere", () => {
  it("returns every workspace in the org for admins/owners", () => {
    expect(visibleWorkspacesWhere("u1", "org-1", "admin")).toEqual({
      organizationId: "org-1",
    });
  });

  it("scopes a member to bound workspaces only (direct or via group) — no creator arm", () => {
    const where = visibleWorkspacesWhere("u1", "org-1", "member");
    expect(where).toMatchObject({ organizationId: "org-1" });
    expect(where.OR).toEqual([
      { accessBindings: { some: { userId: "u1" } } },
      {
        accessBindings: {
          some: { group: { members: { some: { userId: "u1" } } } },
        },
      },
    ]);
  });
});

describe("hasWorkspaceAccessBinding", () => {
  beforeEach(() => {
    state.binding = null;
  });

  it("is true when a matching binding exists", async () => {
    state.binding = { id: "b1" };
    await expect(hasWorkspaceAccessBinding("u1", "p1")).resolves.toBe(true);
  });

  it("is false with no binding", async () => {
    await expect(hasWorkspaceAccessBinding("u1", "p1")).resolves.toBe(false);
  });
});

// step 13c: management rides an OWNER-role user binding; a plain member binding
// does not grant it. The mock routes findFirst by the `role` filter.
describe("hasWorkspaceOwnerBinding", () => {
  beforeEach(() => {
    state.binding = null;
    state.ownerBinding = null;
    state.bindingProbes = [];
  });

  it("is true when an owner-role binding exists", async () => {
    state.ownerBinding = { id: "b1" };
    await expect(hasWorkspaceOwnerBinding("u1", "p1")).resolves.toBe(true);
  });

  it("queries a direct user binding scoped to role owner", async () => {
    await hasWorkspaceOwnerBinding("u1", "p1");
    expect(state.bindingProbes[0]).toMatchObject({
      where: { workspaceId: "p1", userId: "u1", role: "owner" },
    });
  });

  it("is false when the user's only binding is a member role", async () => {
    state.binding = { id: "b1" }; // a member (non-owner) binding exists
    state.ownerBinding = null; // but no owner binding
    await expect(hasWorkspaceOwnerBinding("u1", "p1")).resolves.toBe(false);
  });
});

describe("canAccessWorkspace (usage is bindings-only since 13b)", () => {
  beforeEach(() => {
    state.membership = null;
    state.workspace = null;
    state.binding = null;
    state.workspaceProbes = [];
  });

  it("is false when the workspace isn't visible in the user's orgs", async () => {
    await expect(canAccessWorkspace("u1", "p1")).resolves.toBe(false);
  });

  it("enforces suspension through the visibility filter (status != suspended)", async () => {
    // Suspension is enforced by the findFirst relation filter, not the binding
    // query (which is status-blind) — pin that the filter is present.
    state.workspace = { createdByUserId: "creator", organizationId: "org-1" };
    state.binding = { id: "b1" };
    await canAccessWorkspace("u1", "p1");
    expect(state.workspaceProbes[0]).toMatchObject({
      where: {
        organization: {
          members: { some: { userId: "u1", status: { not: "suspended" } } },
        },
      },
    });
  });

  it("grants a user holding a WorkspaceAccess binding (incl. the creator's seeded one)", async () => {
    state.workspace = { createdByUserId: "u1", organizationId: "org-1" };
    state.binding = { id: "b1" };
    await expect(canAccessWorkspace("u1", "p1")).resolves.toBe(true);
  });

  it("grants a non-creator holding a WorkspaceAccess binding", async () => {
    state.workspace = { createdByUserId: "creator", organizationId: "org-1" };
    state.binding = { id: "b1" };
    await expect(canAccessWorkspace("u1", "p1")).resolves.toBe(true);
  });

  it("grants an org admin without a binding", async () => {
    state.workspace = { createdByUserId: "creator", organizationId: "org-1" };
    state.membership = { role: "admin", status: "active" };
    await expect(canAccessWorkspace("u1", "p1")).resolves.toBe(true);
  });

  it("denies a plain member with no binding", async () => {
    state.workspace = { createdByUserId: "creator", organizationId: "org-1" };
    state.membership = { role: "member", status: "active" };
    await expect(canAccessWorkspace("u1", "p1")).resolves.toBe(false);
  });

  it("denies the creator once their binding is removed (no creator arm)", async () => {
    // THE 13b behavior change: a creator is just a member now — with no binding
    // and no admin role they no longer get in for free.
    state.workspace = { createdByUserId: "u1", organizationId: "org-1" };
    state.membership = { role: "member", status: "active" };
    state.binding = null;
    await expect(canAccessWorkspace("u1", "p1")).resolves.toBe(false);
  });
});

// step 13c: management moved onto an OWNER-role binding OR org admin/owner. The
// creator arm is gone — a creator with no owner binding no longer manages.
describe("canManageWorkspace (owner-role binding OR org admin)", () => {
  beforeEach(() => {
    state.membership = null;
    state.workspace = null;
    state.binding = null;
    state.ownerBinding = null;
    state.workspaceProbes = [];
  });

  it("grants a user holding an owner-role binding", async () => {
    state.workspace = { createdByUserId: "creator", organizationId: "org-1" };
    state.membership = { role: "member", status: "active" };
    state.ownerBinding = { id: "b1" };
    await expect(canManageWorkspace("u1", "p1")).resolves.toBe(true);
  });

  it("grants an org admin with no binding", async () => {
    state.workspace = { createdByUserId: "creator", organizationId: "org-1" };
    state.membership = { role: "admin", status: "active" };
    await expect(canManageWorkspace("u1", "p1")).resolves.toBe(true);
  });

  it("denies a member with only a use (non-owner) binding — use, not manage", async () => {
    state.workspace = { createdByUserId: "creator", organizationId: "org-1" };
    state.binding = { id: "b1" }; // a member binding (usage), but not owner
    state.ownerBinding = null;
    state.membership = { role: "member", status: "active" };
    await expect(canManageWorkspace("u1", "p1")).resolves.toBe(false);
  });

  it("denies the creator once their owner binding is gone (no creator arm)", async () => {
    // THE 13c behavior change: creation alone no longer confers management.
    state.workspace = { createdByUserId: "u1", organizationId: "org-1" };
    state.membership = { role: "member", status: "active" };
    state.ownerBinding = null;
    await expect(canManageWorkspace("u1", "p1")).resolves.toBe(false);
  });

  it("enforces suspension through the workspace relation filter", async () => {
    // Suspension is enforced by the findFirst filter (status != suspended) before
    // any binding check — pin that the filter is present on the probe.
    state.workspace = { createdByUserId: "u1", organizationId: "org-1" };
    state.ownerBinding = { id: "b1" };
    await canManageWorkspace("u1", "p1");
    expect(state.workspaceProbes[0]).toMatchObject({
      where: {
        organization: {
          members: { some: { userId: "u1", status: { not: "suspended" } } },
        },
      },
    });
  });
});

// The injected WorkspaceAccessChecker (the licensed implementation behind the
// shared predicates in services/workspace-access-check.ts). These pin the
// RBAC access law: the suspension invariant with its ORDERING (a suspended
// member's stale binding is never even consulted), the admin bypass, and the
// member-needs-a-binding rule.
describe("eeWorkspaceAccessChecker", () => {
  const WS = { id: "p1", organizationId: "o1" };

  beforeEach(() => {
    state.membership = null;
    state.binding = null;
    state.bindingProbes = [];
  });

  it("denies a non-member outright", async () => {
    await expect(
      eeWorkspaceAccessChecker.canAccessWorkspaceAsUser("u1", WS),
    ).resolves.toBe(false);
  });

  it("denies a suspended member WITHOUT consulting their binding", async () => {
    state.membership = { role: "member", status: "suspended" };
    state.binding = { id: "b1" }; // a stale binding that must never rescue them
    await expect(
      eeWorkspaceAccessChecker.canAccessWorkspaceAsUser("u1", WS),
    ).resolves.toBe(false);
    // The ordering IS the invariant: no-role short-circuits before the
    // binding query ever runs.
    expect(state.bindingProbes).toEqual([]);
  });

  it("admin/owner passes without a binding", async () => {
    state.membership = { role: "admin", status: "active" };
    await expect(
      eeWorkspaceAccessChecker.canAccessWorkspaceAsUser("u1", WS),
    ).resolves.toBe(true);
    expect(state.bindingProbes).toEqual([]);
  });

  it("an active member passes iff they hold a binding", async () => {
    state.membership = { role: "member", status: "active" };
    state.binding = { id: "b1" };
    await expect(
      eeWorkspaceAccessChecker.canAccessWorkspaceAsUser("u1", WS),
    ).resolves.toBe(true);
    state.binding = null;
    await expect(
      eeWorkspaceAccessChecker.canAccessWorkspaceAsUser("u1", WS),
    ).resolves.toBe(false);
  });

  it("userIsOrgAdmin: admin/owner yes, member/suspended/none no", async () => {
    state.membership = { role: "owner", status: "active" };
    await expect(
      eeWorkspaceAccessChecker.userIsOrgAdmin("u1", "o1"),
    ).resolves.toBe(true);
    state.membership = { role: "member", status: "active" };
    await expect(
      eeWorkspaceAccessChecker.userIsOrgAdmin("u1", "o1"),
    ).resolves.toBe(false);
    state.membership = { role: "admin", status: "suspended" };
    await expect(
      eeWorkspaceAccessChecker.userIsOrgAdmin("u1", "o1"),
    ).resolves.toBe(false);
    state.membership = null;
    await expect(
      eeWorkspaceAccessChecker.userIsOrgAdmin("u1", "o1"),
    ).resolves.toBe(false);
  });
});
