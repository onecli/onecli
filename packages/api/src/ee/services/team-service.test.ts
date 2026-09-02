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

const cognito = vi.hoisted(() => ({
  revokeUserAccess: vi.fn(async () => "disabled" as const),
  restoreUserAccess: vi.fn(async () => "enabled" as const),
}));

vi.mock("../sso/cognito-user-service", () => cognito);

// createInvitation gates new seats through the quota assert and cleans
// expired provision placeholders first — spy on both to pin ordering and the
// resend exemption without dragging in their real db reads.
const quota = vi.hoisted(() => ({
  assertCanInviteMember: vi.fn(async () => {}),
}));

vi.mock("./quota-service", () => quota);

// removeMember deletes truly-personal workspaces via workspace-service.deleteWorkspace
// — stub it so the real cascade (a callback $transaction) doesn't run, and so we
// can assert exactly which workspaces were deleted.
const workspaceService = vi.hoisted(() => ({
  deleteWorkspace: vi.fn(async () => {}),
}));

vi.mock("./workspace-service", () => workspaceService);

// reconcileMemberRoles flushes the org gateway cache when a role changes.
vi.mock("../../lib/gateway-invalidate", () => ({
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

import {
  removeMember,
  reinstateMember,
  setMemberSsoExempt,
  suspendMember,
  changeMemberRole,
  reconcileMemberRoles,
} from "./team-service";

beforeEach(() => {
  state.memberCreates = [];
  state.workspaceCreates = [];
  state.invitationUpdates = [];
  state.invitationUpserts = [];
  state.invitation = null;
  state.memberByEmail = null;
  state.transactionOps = [];
  state.membership = null;
  state.memberUpdates = [];
  state.memberDeletes = [];
  state.workspaceAccessDeletes = [];
  state.groupMemberDeletes = [];
  state.membershipCount = 1;
  state.workspaceFindManyArgs = [];
  state.personalWorkspaces = [];
  state.mappedRows = [];
  state.reconcileMembers = [];
  state.mappingCount = 0;
  cognito.revokeUserAccess.mockClear();
  cognito.restoreUserAccess.mockClear();
  workspaceService.deleteWorkspace.mockClear();
  quota.assertCanInviteMember.mockClear();
  quota.assertCanInviteMember.mockResolvedValue(undefined);
});

// This suite exercises licensed features — run it entitled. The unlicensed
// refusal of each feature is proven in licensing/enterprise-lock.test.ts.
beforeAll(() => initEntitlementForTests(true));
afterAll(() => initEntitlementForTests(null));

const TARGET_MEMBERSHIP = {
  role: "member",
  status: "active",
  userEmail: "t@a.com",
  user: { externalAuthId: "sub-t" },
};

describe("suspendMember", () => {
  it("flips status FIRST, then best-effort revocation with the pre-flip count", async () => {
    state.membership = TARGET_MEMBERSHIP;
    state.membershipCount = 1;

    await expect(suspendMember("org-1", "user-t", "user-admin")).resolves.toBe(
      "disabled",
    );
    expect(state.memberUpdates[0]).toMatchObject({
      data: { status: "suspended", suspendedAt: expect.any(Date) },
    });
    expect(cognito.revokeUserAccess).toHaveBeenCalledWith({
      userId: "user-t",
      externalAuthId: "sub-t",
      organizationId: "org-1",
      membershipCount: 1,
    });
  });

  it("guards: self, owner, non-member, already suspended", async () => {
    await expect(suspendMember("org-1", "user-a", "user-a")).rejects.toThrow(
      "yourself",
    );

    state.membership = null;
    await expect(suspendMember("org-1", "user-t", "user-a")).rejects.toThrow(
      "not a member",
    );

    state.membership = { ...TARGET_MEMBERSHIP, role: "owner" };
    await expect(suspendMember("org-1", "user-t", "user-a")).rejects.toThrow(
      "owner",
    );

    state.membership = { ...TARGET_MEMBERSHIP, status: "suspended" };
    await expect(suspendMember("org-1", "user-t", "user-a")).rejects.toThrow(
      "already suspended",
    );
    expect(state.memberUpdates).toHaveLength(0);
    expect(cognito.revokeUserAccess).not.toHaveBeenCalled();
  });
});

describe("reinstateMember", () => {
  it("flips back and restores the Cognito login", async () => {
    state.membership = { ...TARGET_MEMBERSHIP, status: "suspended" };
    await expect(reinstateMember("org-1", "user-t")).resolves.toBe("enabled");
    expect(state.memberUpdates[0]).toMatchObject({
      data: { status: "active", suspendedAt: null },
    });
    expect(cognito.restoreUserAccess).toHaveBeenCalledWith({
      userId: "user-t",
      externalAuthId: "sub-t",
    });
  });

  it("only reinstates suspended members", async () => {
    state.membership = TARGET_MEMBERSHIP;
    await expect(reinstateMember("org-1", "user-t")).rejects.toThrow(
      "not suspended",
    );
  });
});

describe("setMemberSsoExempt", () => {
  it("flips the flag for an existing member (owners included)", async () => {
    state.membership = { userId: "user-t" };
    await setMemberSsoExempt("org-1", "user-t", true);
    expect(state.memberUpdates[0]).toMatchObject({
      data: { ssoExempt: true },
    });
  });

  it("rejects non-members", async () => {
    state.membership = null;
    await expect(setMemberSsoExempt("org-1", "user-t", true)).rejects.toThrow(
      "not a member",
    );
  });
});

describe("removeMember revocation wiring", () => {
  it("computes the ownership inputs pre-delete and revokes after the delete", async () => {
    state.membership = TARGET_MEMBERSHIP;
    state.membershipCount = 1;

    await expect(removeMember("org-1", "user-t")).resolves.toBe("disabled");
    expect(state.memberDeletes).toHaveLength(1);
    expect(cognito.revokeUserAccess).toHaveBeenCalledWith({
      userId: "user-t",
      externalAuthId: "sub-t",
      organizationId: "org-1",
      membershipCount: 1,
    });
  });

  it("voluntary self-leave never revokes the leaver's login", async () => {
    state.membership = TARGET_MEMBERSHIP;
    await expect(
      removeMember("org-1", "user-t", { revokeIdentity: false }),
    ).resolves.toBe("skipped");
    expect(state.memberDeletes).toHaveLength(1);
    expect(cognito.revokeUserAccess).not.toHaveBeenCalled();
  });

  it("revokes the member's shared-in bindings + group memberships in the org", async () => {
    // Without this, re-inviting the user later would resurrect every old share.
    // Scoped to this org so their shares elsewhere are untouched.
    state.membership = TARGET_MEMBERSHIP;
    await removeMember("org-1", "user-t");
    expect(state.workspaceAccessDeletes[0]).toMatchObject({
      where: { userId: "user-t", workspace: { organizationId: "org-1" } },
    });
    expect(state.groupMemberDeletes[0]).toMatchObject({
      where: { userId: "user-t", group: { organizationId: "org-1" } },
    });
  });

  it("deletes only truly-personal workspaces (13b), stripping the leaver's other bindings", async () => {
    // Since usage is bindings-only, the delete set is: created by the leaver,
    // they STILL hold their own binding (`some: { userId }`), and no one else
    // holds one (`none` of another user's direct binding OR any group binding —
    // group rows have a null userId, caught by the groupId arm). The `some` arm
    // is what spares a workspace the leaver was removed from and an admin adopted
    // (zero bindings) from being destroyed. `personal-1` is such a workspace.
    state.membership = TARGET_MEMBERSHIP;
    state.personalWorkspaces = [{ id: "personal-1" }];

    await removeMember("org-1", "user-t");

    expect(state.workspaceFindManyArgs[0]).toMatchObject({
      where: {
        organizationId: "org-1",
        createdByUserId: "user-t",
        accessBindings: {
          some: { userId: "user-t" },
          none: {
            OR: [{ userId: { not: "user-t" } }, { groupId: { not: null } }],
          },
        },
      },
    });
    expect(workspaceService.deleteWorkspace).toHaveBeenCalledTimes(1);
    expect(workspaceService.deleteWorkspace).toHaveBeenCalledWith("personal-1");
    // The leaver's own binding on the surviving (shared) workspaces is still
    // stripped by the org-scoped deleteMany.
    expect(state.workspaceAccessDeletes[0]).toMatchObject({
      where: { userId: "user-t", workspace: { organizationId: "org-1" } },
    });
  });

  it("deletes nothing when the leaver's workspaces are all shared or admin-adopted", async () => {
    // The filter returns no truly-personal workspaces, so shared workspaces — and a
    // binding-less workspace an admin adopted (`some: { userId }` fails) — survive;
    // only the leaver's own binding on them is stripped, above.
    state.membership = TARGET_MEMBERSHIP;
    state.personalWorkspaces = [];

    await removeMember("org-1", "user-t");

    expect(workspaceService.deleteWorkspace).not.toHaveBeenCalled();
  });
});

describe("reconcileMemberRoles (step 15 applier)", () => {
  const active = (userId: string, role: string) => ({
    userId,
    role,
    status: "active",
    userEmail: `${userId}@x.com`,
  });

  it("promotes a member whose mapped group grants admin", async () => {
    state.mappedRows = [{ userId: "u1", role: "admin", priority: 1 }];
    state.reconcileMembers = [active("u1", "member")];
    await reconcileMemberRoles("org-1", ["u1"], "sso-login");
    expect(state.memberUpdates).toHaveLength(1);
    expect(state.memberUpdates[0]).toMatchObject({ data: { role: "admin" } });
  });

  it("demotes a member whose mapped group grants member", async () => {
    state.mappedRows = [{ userId: "u1", role: "member", priority: 1 }];
    state.reconcileMembers = [active("u1", "admin")];
    await reconcileMemberRoles("org-1", ["u1"], "scim");
    expect(state.memberUpdates).toHaveLength(1);
    expect(state.memberUpdates[0]).toMatchObject({ data: { role: "member" } });
  });

  it("never changes an owner (exempt even inside a mapped group)", async () => {
    state.mappedRows = [{ userId: "u1", role: "member", priority: 1 }];
    state.reconcileMembers = [active("u1", "owner")];
    await reconcileMemberRoles("org-1", ["u1"], "scim");
    expect(state.memberUpdates).toHaveLength(0);
  });

  it("skips a suspended member (suspension outranks the mapping)", async () => {
    state.mappedRows = [{ userId: "u1", role: "admin", priority: 1 }];
    state.reconcileMembers = [
      {
        userId: "u1",
        role: "member",
        status: "suspended",
        userEmail: "u1@x.com",
      },
    ];
    await reconcileMemberRoles("org-1", ["u1"], "scim");
    expect(state.memberUpdates).toHaveLength(0);
  });

  it("leaves an unmatched member's role untouched (never stripped)", async () => {
    state.mappedRows = []; // in no mapped group
    state.reconcileMembers = [active("u1", "admin")];
    await reconcileMemberRoles("org-1", ["u1"], "sso-login");
    expect(state.memberUpdates).toHaveLength(0);
  });

  it("is a no-op when the role already matches the mapping", async () => {
    state.mappedRows = [{ userId: "u1", role: "member", priority: 1 }];
    state.reconcileMembers = [active("u1", "member")];
    await reconcileMemberRoles("org-1", ["u1"], "scim");
    expect(state.memberUpdates).toHaveLength(0);
  });
});

describe("changeMemberRole IdP lock (step 15)", () => {
  it("refuses to change a member whose role is governed by a mapping", async () => {
    state.membership = { role: "member", userEmail: "u1@x.com" };
    state.mappingCount = 1; // sits in a mapped group
    await expect(changeMemberRole("org-1", "u1", "admin")).rejects.toThrow(
      /managed by your identity provider/i,
    );
    expect(state.memberUpdates).toHaveLength(0);
  });

  it("allows changing an unmapped member's role", async () => {
    state.membership = { role: "member", userEmail: "u1@x.com" };
    state.mappingCount = 0; // no mapping covers them
    await changeMemberRole("org-1", "u1", "admin");
    expect(state.memberUpdates).toHaveLength(1);
    expect(state.memberUpdates[0]).toMatchObject({ data: { role: "admin" } });
  });

  it("still blocks changing an owner (the owner guard precedes the lock)", async () => {
    state.membership = { role: "owner", userEmail: "u1@x.com" };
    state.mappingCount = 0;
    await expect(changeMemberRole("org-1", "u1", "admin")).rejects.toThrow(
      /owner/i,
    );
  });
});

describe("reinstateMember reconcile wiring (step 15)", () => {
  it("re-resolves a reinstated member's role from their mapped group (after the status flip)", async () => {
    state.membership = {
      status: "suspended",
      user: { externalAuthId: "ext-1" },
    };
    // Reconcile (which runs after the status→active flip) sees the member active
    // as admin, but their mapped group grants member → the mapping wins. If the
    // reconcile ran BEFORE the flip, the member would still read as suspended and
    // be skipped — so this asserts the ordering too.
    state.reconcileMembers = [
      { userId: "u1", role: "admin", status: "active", userEmail: "u1@x.com" },
    ];
    state.mappedRows = [{ userId: "u1", role: "member", priority: 1 }];

    await reinstateMember("org-1", "u1");

    expect(
      state.memberUpdates.some(
        (u) => (u as { data?: { role?: string } }).data?.role === "member",
      ),
    ).toBe(true);
  });
});
