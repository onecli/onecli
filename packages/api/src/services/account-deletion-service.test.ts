import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Account deletion tears down the user's organizations on the way out, so a
 * user is never stuck: the old blocker ("leave every org first") could not be
 * satisfied on self-host, where a user with no org is immediately handed a
 * fresh one on the next session sync. The law pinned here:
 *
 *   - an org the user owns alone is DELETED (with all its workspaces);
 *   - an org shared with others is LEFT (personal workspaces only);
 *   - an org the user owns WITH other members BLOCKS the whole deletion
 *     (409), before anything is destroyed;
 *   - leaves run before deletes, so a license-freeze on delete cannot fire
 *     after a sibling org is already gone;
 *   - rows the user AUTHORED in an org that outlives them (invitations sent,
 *     provisions minted — both RESTRICT FKs) pass to that org's owner, so a
 *     departed admin's open invitations and pending placeholders survive
 *     and the user row can go;
 *   - the policy rules naming only this user go in the same transaction,
 *     before the user row (their identities cascade, and an identity-less
 *     rule applies to everyone), and those orgs' gateway caches are flushed;
 *   - the user's remaining API keys are flushed from the gateway cache.
 */

const state = vi.hoisted(() => ({
  memberships: [] as {
    role: string;
    organization: {
      id: string;
      name: string;
      members: { userId: string }[];
      workspaces: { id: string; name: string | null }[];
    };
  }[],
  personal: {} as Record<string, { id: string; name: string | null }[]>,
  /** Orgs where the user still authored invitations / provisions. */
  authoredIn: [] as string[],
  /** Owner found per org for the reassignment (null = broken org). */
  ownerOf: {} as Record<string, string | null>,
  userKeys: [] as string[],
  /** Orgs whose rules named only this user (`dropPrincipalFromPolicyInTx`). */
  policyOrgs: [] as string[],
  calls: [] as string[],
  deleteOrgError: null as Error | null,
  flushedOrgs: [] as string[],
  flushedKeys: [] as string[],
}));

vi.mock("../lib/logger", () => ({
  logger: {
    child: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  },
}));
vi.mock("../lib/gateway-invalidate", () => ({
  invalidateGatewayCacheForOrg: (orgId: string) =>
    state.flushedOrgs.push(orgId),
  invalidateGatewayCacheForKeys: (keys: string[]) =>
    state.flushedKeys.push(...keys),
}));
vi.mock("../ee/services/team-service", () => ({
  findDeletablePersonalWorkspaces: async (orgId: string) =>
    (state.personal[orgId] ?? []).map((w) => ({ ...w, channelApps: [] })),
  removeMember: async (
    orgId: string,
    _userId: string,
    options?: { revokeIdentity?: boolean },
  ) => {
    state.calls.push(
      `leave:${orgId}${options?.revokeIdentity === false ? ":keep-login" : ""}`,
    );
    return "skipped";
  },
}));
vi.mock("../ee/services/organization-service", () => ({
  deleteOrganization: async (orgId: string) => {
    if (state.deleteOrgError) throw state.deleteOrgError;
    state.calls.push(`delete:${orgId}`);
  },
}));
// The rule cleanup itself is proven on real Postgres
// (policy-principal-delete.pg.test.ts); here only its place in the teardown.
vi.mock("./policy-service", () => ({
  dropPrincipalFromPolicyInTx: async (
    _tx: unknown,
    principal: { kind: string; id: string },
  ) => {
    state.calls.push(`policy.drop:${principal.kind}:${principal.id}`);
    return state.policyOrgs;
  },
}));
vi.mock("@onecli/db", () => {
  const recorded = (name: string) => async () => {
    state.calls.push(name);
  };
  const authored = async () =>
    state.authoredIn.map((organizationId) => ({ organizationId }));
  const reassign =
    (name: string) =>
    async ({
      where,
      data,
    }: {
      where: { organizationId: string };
      data: Record<string, string>;
    }) => {
      state.calls.push(
        `${name}:${where.organizationId}->${Object.values(data)[0]}`,
      );
    };
  const dropAuthored =
    (name: string) =>
    async ({ where }: { where: { organizationId?: string } }) => {
      state.calls.push(
        where.organizationId ? `${name}:${where.organizationId}` : name,
      );
    };
  const tx = {
    user: { delete: recorded("user.delete") },
    apiKey: {
      findMany: async () => state.userKeys.map((key) => ({ key })),
      deleteMany: recorded("apiKey.deleteMany"),
    },
    userProvision: { deleteMany: dropAuthored("userProvision.deleteMany") },
    onboardingSurvey: { deleteMany: recorded("onboardingSurvey.deleteMany") },
    auditLog: { deleteMany: recorded("auditLog.deleteMany") },
  };
  return {
    db: {
      ...tx,
      organizationMember: {
        findMany: async () => state.memberships,
        findFirst: async ({ where }: { where: { organizationId: string } }) => {
          const owner = state.ownerOf[where.organizationId];
          return owner ? { userId: owner } : null;
        },
      },
      workspace: { updateMany: recorded("workspace.orphan") },
      invitation: {
        findMany: authored,
        updateMany: reassign("invitation.reassign"),
        deleteMany: dropAuthored("invitation.deleteMany"),
      },
      userProvision: {
        findMany: authored,
        updateMany: reassign("userProvision.reassign"),
        deleteMany: dropAuthored("userProvision.deleteMany"),
      },
      $transaction: async (
        arg: Promise<unknown>[] | ((client: typeof tx) => Promise<unknown>),
      ) => (typeof arg === "function" ? arg(tx) : Promise.all(arg)),
    },
  };
});

const { deleteAccount, planAccountDeletion } =
  await import("./account-deletion-service");

const USER = { userId: "u1", userEmail: "u@example.test" };

const org = (
  id: string,
  role: string,
  others: number,
  workspaces: { id: string; name: string | null }[] = [],
) => ({
  role,
  organization: {
    id,
    name: `Org ${id}`,
    members: Array.from({ length: others }, (_, i) => ({ userId: `o${i}` })),
    workspaces,
  },
});

const USER_ROW_TEARDOWN = [
  "workspace.orphan",
  "apiKey.deleteMany",
  "userProvision.deleteMany",
  "onboardingSurvey.deleteMany",
  "auditLog.deleteMany",
  "policy.drop:user:u1",
  "user.delete",
];

describe("account deletion with organizations", () => {
  beforeEach(() => {
    state.memberships = [];
    state.personal = {};
    state.authoredIn = [];
    state.ownerOf = {};
    state.userKeys = [];
    state.policyOrgs = [];
    state.calls = [];
    state.deleteOrgError = null;
    state.flushedOrgs = [];
    state.flushedKeys = [];
  });

  it("plans delete / leave / blocked per organization", async () => {
    state.memberships = [
      org("solo", "owner", 0, [{ id: "w1", name: "Mine" }]),
      org("shared", "member", 2),
      org("boss", "owner", 3, [{ id: "w9", name: "Team" }]),
    ];
    state.personal = { shared: [{ id: "w2", name: "Personal" }] };
    const impacts = await planAccountDeletion(USER.userId);
    expect(impacts.map((i) => [i.organizationId, i.outcome])).toEqual([
      ["solo", "delete"],
      ["shared", "leave"],
      ["boss", "blocked"],
    ]);
    expect(impacts[0]!.workspaces).toEqual([{ id: "w1", name: "Mine" }]);
    expect(impacts[1]!.workspaces).toEqual([{ id: "w2", name: "Personal" }]);
    // Blocked orgs list nothing to destroy — nothing will be.
    expect(impacts[2]!.workspaces).toEqual([]);
    expect(impacts[2]!.otherMemberCount).toBe(3);
  });

  it("leaves shared orgs (keeping the login), deletes sole-member orgs, then removes the user", async () => {
    state.memberships = [org("solo", "owner", 0), org("shared", "member", 1)];
    await deleteAccount(USER);
    expect(state.calls).toEqual([
      "leave:shared:keep-login",
      "delete:solo",
      ...USER_ROW_TEARDOWN,
    ]);
    // The departed org's gateway cache is flushed even without an audit row.
    expect(state.flushedOrgs).toEqual(["shared"]);
  });

  it("refuses with 409 when the user owns an org with other members, touching nothing", async () => {
    state.memberships = [org("solo", "owner", 0), org("boss", "owner", 2)];
    await expect(deleteAccount(USER)).rejects.toMatchObject({
      name: "ServiceError",
      code: "CONFLICT",
      message: expect.stringMatching(/"Org boss".*Transfer ownership/),
    });
    expect(state.calls).toEqual([]);
  });

  it("a failing org delete leaves the user row in place", async () => {
    state.memberships = [org("solo", "owner", 0)];
    state.deleteOrgError = new Error("license freeze");
    await expect(deleteAccount(USER)).rejects.toThrow("license freeze");
    expect(state.calls).not.toContain("user.delete");
  });

  it("still deletes an account with no organizations at all", async () => {
    await deleteAccount(USER);
    expect(state.calls).toEqual(USER_ROW_TEARDOWN);
  });

  it("hands invitations and provisions the user authored to the surviving org's owner", async () => {
    state.memberships = [org("shared", "admin", 3)];
    state.authoredIn = ["shared"];
    state.ownerOf = { shared: "boss" };
    await deleteAccount(USER);
    expect(state.calls).toEqual([
      "leave:shared:keep-login",
      "workspace.orphan",
      "invitation.reassign:shared->boss",
      "userProvision.reassign:shared->boss",
      ...USER_ROW_TEARDOWN.slice(1),
    ]);
  });

  it("drops authored rows only when the org has no owner left to inherit them", async () => {
    state.memberships = [org("shared", "admin", 1)];
    state.authoredIn = ["shared"];
    state.ownerOf = { shared: null };
    await deleteAccount(USER);
    expect(state.calls).toContain("invitation.deleteMany:shared");
    expect(state.calls).toContain("userProvision.deleteMany:shared");
    expect(state.calls).not.toContain("invitation.reassign:shared->boss");
    expect(state.calls.at(-1)).toBe("user.delete");
  });

  it("flushes the user's remaining API keys from the gateway cache after the commit", async () => {
    state.userKeys = ["oc_a", "oc_b"];
    await deleteAccount(USER);
    expect(state.flushedKeys).toEqual(["oc_a", "oc_b"]);
  });

  it("flushes every org whose rules named only this user, including orgs it already left", async () => {
    state.policyOrgs = ["left-earlier", "solo-gone"];
    await deleteAccount(USER);
    expect(state.flushedOrgs).toEqual(["left-earlier", "solo-gone"]);
  });
});
