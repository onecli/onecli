import { beforeEach, describe, expect, it, vi } from "vitest";

// The listWorkspaces fallback test pins cloud so the role arm is meaningful; the
// pure-function suites below don't touch the db mock.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

const state = vi.hoisted(() => ({
  workspaceWheres: [] as Record<string, unknown>[],
  workspaceSelects: [] as (Record<string, unknown> | undefined)[],
  workspaces: [] as Record<string, unknown>[],
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    organizationMember: {
      findMany: async () => [{ organizationId: "org-1" }],
    },
    workspace: {
      findMany: async ({
        where,
        select,
      }: {
        where: Record<string, unknown>;
        select?: Record<string, unknown>;
      }) => {
        state.workspaceWheres.push(where);
        state.workspaceSelects.push(select);
        return state.workspaces;
      },
    },
    secret: { groupBy: async () => [] },
    appConnection: { groupBy: async () => [] },
  },
}));

import {
  listWorkspaces,
  resolveWorkspaceOwner,
  sumWorkspaceResources,
} from "./workspace-service";

const ORG_A = "org_a";
const ORG_B = "org_b";

describe("sumWorkspaceResources", () => {
  it("adds a workspace's own secrets and connections to what it inherits from its org", () => {
    const orgSecretCounts = new Map([[ORG_A, 5]]);
    const orgConnectionCounts = new Map([[ORG_A, 10]]);

    const total = sumWorkspaceResources(
      { organizationId: ORG_A, secretCount: 0, connectionCount: 0 },
      orgSecretCounts,
      orgConnectionCounts,
    );

    // 0 workspace-scoped + 5 global secrets + 10 org connections — the case from
    // the bug report, where the old workspace-only count showed "0".
    expect(total).toBe(15);
  });

  it("applies the org-inherited counts to every workspace in that org", () => {
    const orgSecretCounts = new Map([[ORG_A, 5]]);
    const orgConnectionCounts = new Map([[ORG_A, 10]]);

    const first = sumWorkspaceResources(
      { organizationId: ORG_A, secretCount: 1, connectionCount: 2 },
      orgSecretCounts,
      orgConnectionCounts,
    );
    const second = sumWorkspaceResources(
      { organizationId: ORG_A, secretCount: 0, connectionCount: 0 },
      orgSecretCounts,
      orgConnectionCounts,
    );

    expect(first).toBe(18); // 1 + 2 + 5 + 10
    expect(second).toBe(15); // 0 + 0 + 5 + 10
  });

  it("counts only a workspace's own resources when its org has nothing to inherit", () => {
    const total = sumWorkspaceResources(
      { organizationId: ORG_B, secretCount: 3, connectionCount: 4 },
      new Map([[ORG_A, 5]]),
      new Map([[ORG_A, 10]]),
    );

    // ORG_B is absent from both maps → inherited defaults to 0.
    expect(total).toBe(7);
  });
});

describe("resolveWorkspaceOwner", () => {
  const USER = "user_1";
  const OTHER = "user_2";

  it("marks the viewer's own workspace and uses the creator's name + email", () => {
    const owner = resolveWorkspaceOwner(
      {
        createdByUserId: USER,
        createdByUserEmail: "jane@acme.test",
        createdByUser: { name: "Jane Doe", email: "jane@acme.test" },
      },
      USER,
    );

    expect(owner).toEqual({
      name: "Jane Doe",
      email: "jane@acme.test",
      isCurrentUser: true,
    });
  });

  it("flags a workspace created by someone else as not the current user", () => {
    const owner = resolveWorkspaceOwner(
      {
        createdByUserId: OTHER,
        createdByUserEmail: "sam@acme.test",
        createdByUser: { name: "Sam Lee", email: "sam@acme.test" },
      },
      USER,
    );

    expect(owner).toEqual({
      name: "Sam Lee",
      email: "sam@acme.test",
      isCurrentUser: false,
    });
  });

  it("returns null for a legacy workspace with no recorded creator", () => {
    const owner = resolveWorkspaceOwner(
      { createdByUserId: null, createdByUserEmail: null, createdByUser: null },
      USER,
    );

    expect(owner).toBeNull();
  });

  it("falls back to the denormalized email when the creator's user row is gone", () => {
    const owner = resolveWorkspaceOwner(
      {
        createdByUserId: OTHER,
        createdByUserEmail: "ghost@acme.test",
        createdByUser: null,
      },
      USER,
    );

    expect(owner).toEqual({
      name: null,
      email: "ghost@acme.test",
      isCurrentUser: false,
    });
  });

  it("keeps a null name and uses the email when the creator has no name", () => {
    const owner = resolveWorkspaceOwner(
      {
        createdByUserId: USER,
        createdByUserEmail: "noname@acme.test",
        createdByUser: { name: null, email: "noname@acme.test" },
      },
      USER,
    );

    expect(owner).toEqual({
      name: null,
      email: "noname@acme.test",
      isCurrentUser: true,
    });
  });
});

describe("listWorkspaces fallback scope (13b: bindings-only)", () => {
  beforeEach(() => {
    state.workspaceWheres = [];
  });

  it("scopes the multi-org fallback to WorkspaceAccess bindings, not the creator", async () => {
    // Called with no organizationId → the defensive fallback branch that does
    // NOT flow through visibleWorkspacesWhere. Post-13b it must be bindings-only
    // (direct or via a group) — the createdByUserId arm is gone.
    await listWorkspaces("u1");

    expect(state.workspaceWheres[0]).toEqual({
      organizationId: { in: ["org-1"] },
      OR: [
        { accessBindings: { some: { userId: "u1" } } },
        {
          accessBindings: {
            some: { group: { members: { some: { userId: "u1" } } } },
          },
        },
      ],
    });
  });
});

// step 13c: the list-flag `canManage` flips off createdByUserId onto the viewer's
// own owner-role binding (loaded via a filtered relation in the same query), OR'd
// with the org-admin arm. Mirrors `canManageWorkspace` on the API.
describe("listWorkspaces canManage (13c: owner-role binding)", () => {
  const D = new Date("2026-01-01T00:00:00.000Z");
  const baseWorkspace = {
    name: "P",
    slug: "p",
    createdAt: D,
    organizationId: "org-1",
    createdByUserId: null,
    createdByUserEmail: null,
    createdByUser: null,
    _count: { agents: 0, secrets: 0, appConnections: 0 },
  };

  beforeEach(() => {
    state.workspaceWheres = [];
    state.workspaceSelects = [];
    state.workspaces = [];
  });

  it("is true for a member holding an owner-role binding", async () => {
    // The select filters accessBindings to the viewer's own owner rows, so a
    // non-empty array means they hold one.
    state.workspaces = [
      { id: "p1", ...baseWorkspace, accessBindings: [{ id: "b1" }] },
    ];
    const [p] = await listWorkspaces("u1", "org-1", "member");
    expect(p?.canManage).toBe(true);
    // Pin the select filter — canManage must key off the viewer's OWN owner-role
    // binding, not any share (a regression dropping role:"owner" would flip a
    // plain member share to manageable).
    expect(state.workspaceSelects[0]?.accessBindings).toEqual({
      where: { userId: "u1", role: "owner" },
      select: { id: true },
      take: 1,
    });
  });

  it("is false for a member with no owner-role binding", async () => {
    state.workspaces = [{ id: "p1", ...baseWorkspace, accessBindings: [] }];
    const [p] = await listWorkspaces("u1", "org-1", "member");
    expect(p?.canManage).toBe(false);
  });

  it("is true for an org admin regardless of bindings", async () => {
    state.workspaces = [{ id: "p1", ...baseWorkspace, accessBindings: [] }];
    const [p] = await listWorkspaces("u1", "org-1", "admin");
    expect(p?.canManage).toBe(true);
  });
});
