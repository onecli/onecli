import { beforeEach, describe, expect, it, vi } from "vitest";

// Service-level tests for the app-availability RULE model: ownership checks
// (cross-org IDOR rejection), the rule-id-matched replace-set diff, no-op rule
// dropping, forged-id safety, and the derive. The DB is mocked; the full
// inheritance derivation is proven against real Postgres by the gateway's
// find_available_providers verification (this is its TS mirror).

const store = vi.hoisted(() => ({
  mode: "restricted" as string | null,
  knownProviders: new Set(["gmail", "github", "slack"]),
  memberCount: 0,
  groupCount: 0,
  // getAppAvailability + the set-current read.
  rules: [] as {
    id: string;
    name: string | null;
    providers: string[];
    identities: { userId: string | null; groupId: string | null }[];
  }[],
  // deriveAvailableProviders' matching-rule read.
  matchingRules: [] as { providers: string[] }[],
  // op recording.
  ruleDeleteArgs: [] as unknown[],
  ruleUpdateArgs: [] as unknown[],
  ruleCreateArgs: [] as unknown[],
  identityDeleteArgs: [] as unknown[],
  identityCreateArgs: [] as unknown[],
  orgUpdateArgs: [] as unknown[],
  whereLog: [] as { model: string; where: Record<string, unknown> }[],
  workspaceAccessCalled: 0,
  // derive fixtures.
  accessRows: [] as { userId: string | null; groupId: string | null }[],
  deriveGroups: [] as { id: string }[],
  membersOfDirectGroups: [] as { userId: string }[],
  groupsOfUsers: [] as { groupId: string }[],
  activeMembers: [] as { userId: string }[],
}));

vi.mock("../../apps/registry", () => ({
  getApp: (id: string) => (store.knownProviders.has(id) ? { id } : undefined),
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    organization: {
      findUnique: async () => ({ appAvailabilityMode: store.mode }),
      update: async (args: unknown) => {
        store.orgUpdateArgs.push(args);
        return {};
      },
    },
    appAvailabilityRule: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        store.whereLog.push({ model: "rule.findMany", where });
        // The derive read carries an `identities` filter; get/set-current don't.
        return where.identities ? store.matchingRules : store.rules;
      },
      deleteMany: async (args: unknown) => {
        store.ruleDeleteArgs.push(args);
        return { count: 0 };
      },
      updateMany: async (args: unknown) => {
        store.ruleUpdateArgs.push(args);
        return { count: 1 };
      },
      create: async (args: unknown) => {
        store.ruleCreateArgs.push(args);
        return { id: "new-rule" };
      },
    },
    appAvailabilityRuleIdentity: {
      deleteMany: async (args: unknown) => {
        store.identityDeleteArgs.push(args);
        return { count: 0 };
      },
      createMany: async (args: unknown) => {
        store.identityCreateArgs.push(args);
        return { count: 0 };
      },
    },
    organizationMember: {
      count: async ({ where }: { where: Record<string, unknown> }) => {
        store.whereLog.push({ model: "member.count", where });
        return store.memberCount;
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        store.whereLog.push({ model: "member.findMany", where });
        return store.activeMembers;
      },
    },
    group: {
      count: async ({ where }: { where: Record<string, unknown> }) => {
        store.whereLog.push({ model: "group.count", where });
        return store.groupCount;
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        store.whereLog.push({ model: "group.findMany", where });
        return store.deriveGroups;
      },
    },
    workspaceAccess: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        store.whereLog.push({ model: "workspaceAccess.findMany", where });
        store.workspaceAccessCalled += 1;
        return store.accessRows;
      },
    },
    groupMember: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        store.whereLog.push({ model: "groupMember.findMany", where });
        return where.groupId
          ? store.membersOfDirectGroups
          : store.groupsOfUsers;
      },
    },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));

import {
  setAppAvailability,
  deriveAvailableProviders,
  getAppAvailability,
} from "./app-availability-service";

beforeEach(() => {
  store.mode = "restricted";
  store.knownProviders = new Set(["gmail", "github", "slack"]);
  store.memberCount = 0;
  store.groupCount = 0;
  store.rules = [];
  store.matchingRules = [];
  store.ruleDeleteArgs = [];
  store.ruleUpdateArgs = [];
  store.ruleCreateArgs = [];
  store.identityDeleteArgs = [];
  store.identityCreateArgs = [];
  store.orgUpdateArgs = [];
  store.whereLog = [];
  store.workspaceAccessCalled = 0;
  store.accessRows = [];
  store.deriveGroups = [];
  store.membersOfDirectGroups = [];
  store.groupsOfUsers = [];
  store.activeMembers = [];
});

const expectReject = async (p: Promise<unknown>, code: string) => {
  await expect(p).rejects.toMatchObject({ code });
};

describe("setAppAvailability — ownership / IDOR", () => {
  it("rejects an unknown provider (400)", async () => {
    await expectReject(
      setAppAvailability(
        "org-1",
        {
          mode: "restricted",
          rules: [{ userIds: ["u1"], groupIds: [], providers: ["nope"] }],
        },
        "actor",
      ),
      "BAD_REQUEST",
    );
    expect(store.ruleCreateArgs).toHaveLength(0);
  });

  it("rejects a user not in the org (422), org-fenced + suspended-excluded", async () => {
    store.memberCount = 0; // count < 1 requested user → mismatch
    await expectReject(
      setAppAvailability(
        "org-1",
        {
          mode: "restricted",
          rules: [{ userIds: ["foreign"], groupIds: [], providers: ["gmail"] }],
        },
        "actor",
      ),
      "UNPROCESSABLE",
    );
    const memberWhere = store.whereLog.find((w) => w.model === "member.count")
      ?.where as Record<string, unknown>;
    expect(memberWhere.organizationId).toBe("org-1");
    expect(memberWhere.status).toEqual({ not: "suspended" });
  });

  it("rejects a group not in the org (422)", async () => {
    store.memberCount = 1;
    store.groupCount = 0;
    await expectReject(
      setAppAvailability(
        "org-1",
        {
          mode: "restricted",
          rules: [{ userIds: [], groupIds: ["foreign"], providers: ["gmail"] }],
        },
        "actor",
      ),
      "UNPROCESSABLE",
    );
    const groupWhere = store.whereLog.find((w) => w.model === "group.count")
      ?.where as Record<string, unknown>;
    expect(groupWhere.organizationId).toBe("org-1");
  });
});

describe("setAppAvailability — replace-set diff", () => {
  it("updates a kept rule (replacing identities) and creates a new one", async () => {
    store.memberCount = 1;
    store.groupCount = 1;
    store.rules = [{ id: "old", name: null, providers: [], identities: [] }];
    await setAppAvailability(
      "org-1",
      {
        mode: "restricted",
        rules: [
          {
            id: "old",
            name: "kept",
            userIds: ["u1"],
            groupIds: [],
            providers: ["gmail"],
          },
          { name: "new", userIds: [], groupIds: ["g1"], providers: ["slack"] },
        ],
      },
      "actor",
    );
    // Nothing removed (old is kept).
    expect(store.ruleDeleteArgs).toHaveLength(0);
    // Kept rule updated (org-fenced) + its identities replaced.
    expect(store.ruleUpdateArgs[0]).toMatchObject({
      where: { id: "old", organizationId: "org-1" },
      data: { name: "kept", providers: ["gmail"] },
    });
    expect(store.identityDeleteArgs[0]).toMatchObject({
      where: { ruleId: "old" },
    });
    expect(store.identityCreateArgs[0]).toMatchObject({
      data: [{ userId: "u1", ruleId: "old" }],
    });
    // New rule created with provenance + nested identities.
    expect(store.ruleCreateArgs[0]).toMatchObject({
      data: {
        organizationId: "org-1",
        name: "new",
        providers: ["slack"],
        createdByUserId: "actor",
        identities: { create: [{ groupId: "g1" }] },
      },
    });
    // The mode is always written.
    expect(store.orgUpdateArgs[0]).toMatchObject({
      where: { id: "org-1" },
      data: { appAvailabilityMode: "restricted" },
    });
  });

  it("deletes a rule dropped from the payload (org-fenced)", async () => {
    store.rules = [{ id: "old", name: null, providers: [], identities: [] }];
    await setAppAvailability("org-1", { mode: "open", rules: [] }, "actor");
    expect(store.ruleDeleteArgs[0]).toMatchObject({
      where: { organizationId: "org-1", id: { in: ["old"] } },
    });
    expect(store.ruleCreateArgs).toHaveLength(0);
  });

  it("deletes a rule edited down to a no-op (no apps)", async () => {
    store.rules = [
      {
        id: "r1",
        name: "eng",
        providers: ["gmail"],
        identities: [{ userId: "u1", groupId: null }],
      },
    ];
    await setAppAvailability(
      "org-1",
      {
        // r1 kept its person but lost all apps → a no-op → dropped → deleted.
        mode: "restricted",
        rules: [{ id: "r1", userIds: ["u1"], groupIds: [], providers: [] }],
      },
      "actor",
    );
    expect(store.ruleDeleteArgs[0]).toMatchObject({
      where: { organizationId: "org-1", id: { in: ["r1"] } },
    });
    expect(store.ruleUpdateArgs).toHaveLength(0);
    expect(store.ruleCreateArgs).toHaveLength(0);
  });

  it("rejects a payload with a duplicate rule id", async () => {
    store.memberCount = 1;
    store.rules = [{ id: "r1", name: null, providers: [], identities: [] }];
    await expectReject(
      setAppAvailability(
        "org-1",
        {
          mode: "restricted",
          rules: [
            { id: "r1", userIds: ["u1"], groupIds: [], providers: ["gmail"] },
            { id: "r1", userIds: ["u1"], groupIds: [], providers: ["slack"] },
          ],
        },
        "actor",
      ),
      "BAD_REQUEST",
    );
    expect(store.ruleUpdateArgs).toHaveLength(0);
  });

  it("treats a forged/foreign rule id as a fresh create, never an update", async () => {
    store.memberCount = 1;
    store.rules = [{ id: "old", name: null, providers: [], identities: [] }];
    await setAppAvailability(
      "org-1",
      {
        mode: "restricted",
        rules: [
          {
            id: "not-this-orgs-rule",
            userIds: ["u1"],
            groupIds: [],
            providers: ["gmail"],
          },
        ],
      },
      "actor",
    );
    // The org's real rule (absent from the payload) is deleted...
    expect(store.ruleDeleteArgs[0]).toMatchObject({
      where: { organizationId: "org-1", id: { in: ["old"] } },
    });
    // ...and the forged-id rule is CREATED fresh (no update targets the id).
    expect(store.ruleUpdateArgs).toHaveLength(0);
    expect(store.ruleCreateArgs).toHaveLength(1);
  });

  it("drops no-op rules (no identities OR no apps) before persisting", async () => {
    store.memberCount = 1;
    await setAppAvailability(
      "org-1",
      {
        mode: "restricted",
        rules: [
          { userIds: [], groupIds: [], providers: ["gmail"] }, // no identities
          { userIds: ["u1"], groupIds: [], providers: [] }, // no apps
        ],
      },
      "actor",
    );
    // Both rules are no-ops → nothing created; only the mode is written.
    expect(store.ruleCreateArgs).toHaveLength(0);
    expect(store.orgUpdateArgs).toHaveLength(1);
  });

  it("dedupes repeated ids within a rule", async () => {
    store.memberCount = 1;
    await setAppAvailability(
      "org-1",
      {
        mode: "restricted",
        rules: [
          {
            userIds: ["u1", "u1"],
            groupIds: [],
            providers: ["gmail", "gmail"],
          },
        ],
      },
      "actor",
    );
    const created = store.ruleCreateArgs[0] as {
      data: {
        providers: string[];
        identities: { create: unknown[] };
      };
    };
    expect(created.data.providers).toEqual(["gmail"]);
    expect(created.data.identities.create).toEqual([{ userId: "u1" }]);
  });
});

describe("deriveAvailableProviders", () => {
  it("returns null for an open org without touching WorkspaceAccess", async () => {
    store.mode = "open";
    const result = await deriveAvailableProviders("proj-1", "org-1");
    expect(result).toBeNull();
    expect(store.workspaceAccessCalled).toBe(0);
  });

  it("returns [] for a restricted org with no inherited people", async () => {
    store.mode = "restricted";
    const result = await deriveAvailableProviders("proj-1", "org-1");
    expect(result).toEqual([]);
    expect(store.workspaceAccessCalled).toBe(1);
  });

  it("unions matching rules' providers and org-fences every arm", async () => {
    store.mode = "restricted";
    store.accessRows = [
      { userId: "u-direct", groupId: null },
      { userId: null, groupId: "g-direct" },
    ];
    store.deriveGroups = [{ id: "g-direct" }];
    store.membersOfDirectGroups = [{ userId: "u-via-group" }];
    store.activeMembers = [{ userId: "u-direct" }, { userId: "u-via-group" }];
    store.groupsOfUsers = [{ groupId: "g-direct" }, { groupId: "g-other" }];
    // Two matching rules → union of their providers (dedup slack).
    store.matchingRules = [
      { providers: ["slack", "gmail"] },
      { providers: ["slack", "todoist"] },
    ];

    const result = await deriveAvailableProviders("proj-1", "org-1");
    expect([...result!].sort()).toEqual(["gmail", "slack", "todoist"]);

    const whereFor = (model: string) =>
      store.whereLog.find((w) => w.model === model)?.where ?? {};
    expect(whereFor("group.findMany").organizationId).toBe("org-1");
    const memberWhere = whereFor("member.findMany");
    expect(memberWhere.organizationId).toBe("org-1");
    expect(memberWhere.status).toEqual({ not: "suspended" });
    const userGroupArm = store.whereLog.find(
      (w) => w.model === "groupMember.findMany" && "userId" in w.where,
    )?.where;
    expect(userGroupArm?.group).toEqual({ organizationId: "org-1" });
    // The matching-rule query is org-fenced + filters by the inherited identities.
    const ruleWhere = store.whereLog.find(
      (w) => w.model === "rule.findMany" && "identities" in w.where,
    )?.where as Record<string, unknown>;
    expect(ruleWhere.organizationId).toBe("org-1");
    expect(ruleWhere.identities).toBeDefined();
  });
});

describe("getAppAvailability — shape", () => {
  it("returns rules with identities split into userIds/groupIds", async () => {
    store.mode = "restricted";
    store.rules = [
      {
        id: "r1",
        name: "eng",
        providers: ["slack", "gmail"],
        identities: [
          { userId: "u1", groupId: null },
          { userId: null, groupId: "g1" },
        ],
      },
    ];
    const config = await getAppAvailability("org-1");
    expect(config.mode).toBe("restricted");
    expect(config.rules).toEqual([
      {
        id: "r1",
        name: "eng",
        userIds: ["u1"],
        groupIds: ["g1"],
        providers: ["slack", "gmail"],
      },
    ]);
  });
});
