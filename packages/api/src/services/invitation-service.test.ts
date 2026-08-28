import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Invitations, now free code.
 *
 * What is pinned here is that the two edition-specific moments — the cloud seat
 * cap and enterprise role reconciliation — reach the flow ONLY through
 * `TeamHooks`. That is what lets this file live outside the licensed paths: an
 * unlicensed deployment runs the same invitation code with both hooks no-ops.
 */

const hooks = vi.hoisted(() => ({
  beforeInviteMember: vi.fn(async () => {}),
  afterMemberJoined: vi.fn(async () => {}),
}));

vi.mock("../providers/hooks/team-hooks", () => ({
  getTeamHooks: () => hooks,
}));

const state = vi.hoisted(() => ({
  memberCreates: [] as Record<string, unknown>[],
  workspaceCreates: [] as Record<string, unknown>[],
  invitationUpdates: [] as Record<string, unknown>[],
  invitationUpserts: [] as Record<string, unknown>[],
  invitation: null as Record<string, unknown> | null,
  memberByEmail: null as Record<string, unknown> | null,
  transactionOps: [] as unknown[][],
  membership: null as Record<string, unknown> | null,
  memberUpdates: [] as Record<string, unknown>[],
  memberDeletes: [] as Record<string, unknown>[],
  workspaceAccessDeletes: [] as Record<string, unknown>[],
  groupMemberDeletes: [] as Record<string, unknown>[],
  membershipCount: 1,
  workspaceFindManyArgs: [] as Record<string, unknown>[],
  personalWorkspaces: [] as { id: string }[],
  // step 15: reconcileMemberRoles + the changeMemberRole lock
  mappedRows: [] as { userId: string; role: string; priority: number }[],
  reconcileMembers: [] as {
    userId: string;
    role: string;
    status: string;
    userEmail: string;
  }[],
  mappingCount: 0,
}));

// reconcileMemberRoles flushes the org gateway cache when a role changes.
vi.mock("../lib/gateway-invalidate", () => ({
  invalidateGatewayCacheForOrg: vi.fn(),
  invalidateGatewayCacheForAccount: vi.fn(),
}));

vi.mock("@onecli/db", () => ({
  db: {
    organizationMember: {
      create: (args: Record<string, unknown>) => {
        state.memberCreates.push(args);
        return args;
      },
      findFirst: async () => state.memberByEmail,
      findUnique: async () => state.membership,
      update: async (args: Record<string, unknown>) => {
        state.memberUpdates.push(args);
        return args;
      },
      delete: async (args: Record<string, unknown>) => {
        state.memberDeletes.push(args);
        return args;
      },
      count: async () => state.membershipCount,
      findMany: async () => state.reconcileMembers,
    },
    workspace: {
      create: (args: Record<string, unknown>) => {
        state.workspaceCreates.push(args);
        return args;
      },
      findMany: async (args: Record<string, unknown>) => {
        state.workspaceFindManyArgs.push(args);
        return state.personalWorkspaces;
      },
    },
    apiKey: {
      deleteMany: async () => ({ count: 0 }),
    },
    workspaceAccess: {
      deleteMany: async (args: Record<string, unknown>) => {
        state.workspaceAccessDeletes.push(args);
        return { count: 0 };
      },
    },
    groupMember: {
      deleteMany: async (args: Record<string, unknown>) => {
        state.groupMemberDeletes.push(args);
        return { count: 0 };
      },
      findMany: async () =>
        state.mappedRows.map((m) => ({
          userId: m.userId,
          group: { roleMapping: { role: m.role, priority: m.priority } },
        })),
    },
    invitation: {
      findUnique: async () => state.invitation,
      update: (args: Record<string, unknown>) => {
        state.invitationUpdates.push(args);
        return args;
      },
      upsert: async (args: Record<string, unknown>) => {
        state.invitationUpserts.push(args);
        return { id: "inv-1", token: "tok-1" };
      },
    },
    groupRoleMapping: {
      count: async () => state.mappingCount,
    },
    auditLog: {
      create: async (args: Record<string, unknown>) => args,
    },
    $transaction: async (ops: unknown[]) => {
      state.transactionOps.push(ops);
      return ops;
    },
  },
}));

import { acceptInvitation, createInvitation } from "./invitation-service";
import { memberProvisionOps } from "./organization-service";

beforeEach(() => {
  state.memberCreates = [];
  state.workspaceCreates = [];
  state.invitationUpdates = [];
  state.invitationUpserts = [];
  state.invitation = null;
  state.memberByEmail = null;
  state.transactionOps = [];
  hooks.beforeInviteMember.mockClear();
  hooks.beforeInviteMember.mockResolvedValue(undefined);
  hooks.afterMemberJoined.mockClear();
});

describe("createInvitation seat gating (through TeamHooks)", () => {
  const params = {
    organizationId: "org-1",
    email: "new@example.com",
    role: "member",
    invitedById: "user-1",
    invitedByEmail: "owner@example.com",
  };

  it("charges a seat for a brand-new invite (assert, then write)", async () => {
    const result = await createInvitation(params);
    expect(hooks.beforeInviteMember).toHaveBeenCalledWith("org-1");
    expect(state.invitationUpserts).toHaveLength(1);
    expect(result).toEqual({ id: "inv-1", token: "tok-1" });
  });

  it("propagates the cap error and never writes the invitation", async () => {
    hooks.beforeInviteMember.mockRejectedValueOnce(
      new Error("members limit reached (3/3 on free plan)"),
    );
    await expect(createInvitation(params)).rejects.toThrow(/limit reached/);
    expect(state.invitationUpserts).toHaveLength(0);
  });

  it("resends a still-pending invitation without a seat check", async () => {
    state.invitation = {
      status: "pending",
      expiresAt: new Date(Date.now() + 86_400_000),
    };
    await createInvitation(params);
    // Seat-neutral: that invite is already counted as a committed seat.
    expect(hooks.beforeInviteMember).not.toHaveBeenCalled();
    expect(state.invitationUpserts).toHaveLength(1);
  });

  it.each([
    ["cancelled", new Date(Date.now() + 86_400_000)],
    ["accepted", new Date(Date.now() + 86_400_000)],
    ["pending but expired", new Date(Date.now() - 1)],
  ])(
    "re-charges the seat when reclaiming a %s row",
    async (label, expiresAt) => {
      state.invitation = {
        status: label.startsWith("pending") ? "pending" : label,
        expiresAt,
      };
      await createInvitation(params);
      expect(hooks.beforeInviteMember).toHaveBeenCalledWith("org-1");
    },
  );

  it("prefers the already-a-member error over the seat cap", async () => {
    state.memberByEmail = { userId: "user-2" };
    hooks.beforeInviteMember.mockRejectedValue(
      new Error("members limit reached"),
    );
    await expect(createInvitation(params)).rejects.toThrow(/already a member/);
    expect(hooks.beforeInviteMember).not.toHaveBeenCalled();
  });

  it("rejects invalid roles before any db or quota work", async () => {
    await expect(
      createInvitation({ ...params, role: "owner" }),
    ).rejects.toThrow(/Invalid role/);
    expect(hooks.beforeInviteMember).not.toHaveBeenCalled();
    expect(state.invitationUpserts).toHaveLength(0);
  });
});

describe("memberProvisionOps", () => {
  it("builds the member + owner-named-workspace pair with seeds", () => {
    const ops = memberProvisionOps(
      "org-1",
      "user-12345678",
      "g@a.com",
      "member",
      "John Smith",
    );
    expect(ops).toHaveLength(2);
    expect(state.memberCreates[0]).toMatchObject({
      data: {
        organizationId: "org-1",
        userId: "user-12345678",
        userEmail: "g@a.com",
        role: "member",
      },
    });
    const workspace = state.workspaceCreates[0] as {
      data: {
        name: string;
        slug: string;
        organizationId: string;
        apiKeys: unknown;
        agents?: unknown;
        accessBindings: unknown;
      };
    };
    expect(workspace.data).toMatchObject({
      name: "John Smith",
      slug: "john-smith-user-123",
      organizationId: "org-1",
    });
    expect(workspace.data.apiKeys).toBeTruthy();
    // No agent is seeded — a provisioned workspace starts empty.
    expect(workspace.data.agents).toBeUndefined();
    // The creator's WorkspaceAccess binding is seeded owner (step 13c) with the workspace.
    expect(workspace.data.accessBindings).toEqual({
      create: { userId: "user-12345678", role: "owner" },
    });
  });

  it("falls back to the member's email when they have no display name", () => {
    memberProvisionOps("org-1", "user-12345678", "g@a.com", "member", null);
    const workspace = state.workspaceCreates[0] as {
      data: { name: string; slug: string };
    };
    expect(workspace.data).toMatchObject({
      name: "g@a.com",
      slug: "g-a-com-user-123",
    });
  });
});

describe("acceptInvitation (extraction stays behavior-identical)", () => {
  it("runs member + workspace + invitation update in one transaction", async () => {
    state.invitation = {
      id: "inv-1",
      organizationId: "org-1",
      email: "g@a.com",
      role: "admin",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
      organization: { name: "Acme" },
    };

    const result = await acceptInvitation(
      "token-1",
      "user-12345678",
      "g@a.com",
      null,
    );
    expect(result).toEqual({
      organizationId: "org-1",
      organizationName: "Acme",
    });
    expect(state.transactionOps[0]).toHaveLength(3);
    expect(state.memberCreates[0]).toMatchObject({
      data: { role: "admin", organizationId: "org-1" },
    });
    expect(state.invitationUpdates[0]).toMatchObject({
      data: { status: "accepted" },
    });
  });

  it("still validates the invitation before provisioning", async () => {
    state.invitation = null;
    await expect(
      acceptInvitation("bad", "user-1", "g@a.com", null),
    ).rejects.toThrow("Invalid invitation link");
    expect(state.transactionOps).toHaveLength(0);
  });
});
