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

// `assertCanCreateOrganization` makes exactly one db call —
// `organizationMember.count` — so mock just that. `state.count` drives the
// returned owned-free-org tally per test; `state.lastWhere` captures the filter
// so we can pin exactly WHO gets counted (owner + free only).
const state = vi.hoisted(() => ({
  count: 0,
  countThrows: false,
  lastWhere: undefined as unknown,
  billing: true,
  secretCount: 0,
  agentCount: 0,
  orgLookups: 0,
  subscriptionStatus: null as string | null,
  maxAgentsOverride: null as number | null,
  maxMembersOverride: null as number | null,
  inviteCount: 0,
  inviteWhere: undefined as unknown,
}));

vi.mock("@onecli/db", () => ({
  db: {
    organizationMember: {
      count: async ({ where }: { where: unknown }) => {
        if (state.countThrows) throw new Error("db unreachable");
        state.lastWhere = where;
        return state.count;
      },
    },
    organization: {
      findUniqueOrThrow: async () => {
        state.orgLookups += 1;
        return {
          subscriptionStatus: state.subscriptionStatus,
          maxAgentsOverride: state.maxAgentsOverride,
          maxMembersOverride: state.maxMembersOverride,
        };
      },
    },
    secret: {
      count: async () => state.secretCount,
    },
    workspace: { count: async () => 0 },
    agent: { count: async () => state.agentCount },
    appConnection: { count: async () => 0 },
    invitation: {
      count: async ({ where }: { where: unknown }) => {
        state.inviteWhere = where;
        return state.inviteCount;
      },
    },
  },
}));

// getOrgLimits gates on CAPS.billing — keep the rest of lib/env real and make
// just the capability switchable per test.
vi.mock("../../lib/env", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  get CAPS() {
    return { billing: state.billing };
  },
}));

import {
  assertCanCreateAgent,
  assertCanCreateOrganization,
  assertCanCreateSecret,
  assertCanInviteMember,
  assertCanShareWorkspace,
  assertCanUseGranularAccess,
  canCreateOrganization,
  getUsageOverview,
  MAX_FREE_ORGS_PER_USER,
  QuotaExceededError,
} from "./quota-service";
import { ServiceError } from "../../services/errors";

beforeEach(() => {
  state.count = 0;
  state.countThrows = false;
  state.lastWhere = undefined;
  state.billing = true;
  state.secretCount = 0;
  state.agentCount = 0;
  state.orgLookups = 0;
  state.subscriptionStatus = null;
  state.maxAgentsOverride = null;
  state.maxMembersOverride = null;
  state.inviteCount = 0;
  state.inviteWhere = undefined;
  // Read at call time by maxOrgsPerUser() — keep the file hermetic to the
  // ambient shell.
  delete process.env.MAX_ORGS_PER_USER;
});

// This suite exercises licensed features — run it entitled. The unlicensed
// refusal of each feature is proven in licensing/enterprise-lock.test.ts.
beforeAll(() => initEntitlementForTests(true));
afterAll(() => initEntitlementForTests(null));

describe("assertCanInviteMember (seats = members + pending invites)", () => {
  it("allows a new seat below the cap", async () => {
    state.subscriptionStatus = "free"; // 3 seats
    state.count = 1;
    state.inviteCount = 1; // 2 of 3 used
    await expect(assertCanInviteMember("org-1")).resolves.toBeUndefined();
  });

  it("blocks when members + pending invites reach the cap", async () => {
    state.subscriptionStatus = "free";
    state.count = 1;
    state.inviteCount = 2; // 3 of 3 — the next seat would overshoot
    try {
      await assertCanInviteMember("org-1");
      expect.unreachable("should have thrown QuotaExceededError");
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      const quota = err as QuotaExceededError;
      expect(quota.resource).toBe("members");
      expect(quota.current).toBe(3);
      expect(quota.limit).toBe(3);
      expect(quota.plan).toBe("free");
    }
  });

  it("counts only pending, unexpired invitations", async () => {
    state.subscriptionStatus = "team";
    await assertCanInviteMember("org-9");
    expect(state.inviteWhere).toEqual({
      organizationId: "org-9",
      status: "pending",
      expiresAt: { gte: expect.any(Date) },
    });
  });

  it("counts raw member rows — suspended members and placeholders hold seats", async () => {
    state.subscriptionStatus = "team";
    await assertCanInviteMember("org-9");
    // No status or email filter: only removal frees a seat.
    expect(state.lastWhere).toEqual({ organizationId: "org-9" });
  });

  it.each(["pro", "enterprise"])(
    "never gates uncapped plans (%s) and skips counting entirely",
    async (status) => {
      state.subscriptionStatus = status;
      state.count = 1_000_000;
      state.inviteCount = 1_000_000;
      await expect(assertCanInviteMember("org-1")).resolves.toBeUndefined();
      expect(state.lastWhere).toBeUndefined(); // Infinity early-out
    },
  );

  it("reports members + pending invites in the usage overview", async () => {
    state.subscriptionStatus = "team";
    state.count = 7;
    state.inviteCount = 2;
    const overview = await getUsageOverview("org-1");
    const members = overview.resources.find((r) => r.name === "Members");
    expect(members).toEqual({ name: "Members", current: 9, limit: 10 });
  });
});

describe("assertCanCreateOrganization", () => {
  it("allows creation while below the cap", async () => {
    state.count = MAX_FREE_ORGS_PER_USER - 1; // e.g. owns 2 of 3 free orgs
    await expect(
      assertCanCreateOrganization("user-1"),
    ).resolves.toBeUndefined();
  });

  it("blocks the creation that would exceed the cap", async () => {
    state.count = MAX_FREE_ORGS_PER_USER; // at 3 → the 4th is blocked
    await expect(assertCanCreateOrganization("user-1")).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
  });

  it("keeps blocking users already over the cap (no backfill, just no new orgs)", async () => {
    state.count = MAX_FREE_ORGS_PER_USER + 2; // legacy user with 5 free orgs
    await expect(assertCanCreateOrganization("user-1")).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
  });

  it("counts only orgs the user OWNS and that are FREE", async () => {
    await assertCanCreateOrganization("user-42");
    expect(state.lastWhere).toEqual({
      userId: "user-42",
      role: "owner",
      organization: { subscriptionStatus: "free" },
    });
  });

  it("reports the cap and the free plan on the thrown error", async () => {
    state.count = MAX_FREE_ORGS_PER_USER;
    try {
      await assertCanCreateOrganization("user-1");
      expect.unreachable("should have thrown QuotaExceededError");
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      const quota = err as QuotaExceededError;
      expect(quota.resource).toBe("free organizations");
      expect(quota.current).toBe(MAX_FREE_ORGS_PER_USER);
      expect(quota.limit).toBe(MAX_FREE_ORGS_PER_USER);
      expect(quota.plan).toBe("free");
    }
  });

  it("skips the free-org arm on non-billing editions (quotas are a billing concept)", async () => {
    state.billing = false;
    state.count = MAX_FREE_ORGS_PER_USER + 10; // would trip the arm if reached
    await expect(
      assertCanCreateOrganization("user-1"),
    ).resolves.toBeUndefined();
    // No env cap either → no owner-count query of any kind ran.
    expect(state.lastWhere).toBeUndefined();
  });
});

describe("MAX_ORGS_PER_USER (operator env cap, every edition)", () => {
  it("treats 0 as a real cap — creating any additional org is denied", async () => {
    process.env.MAX_ORGS_PER_USER = "0";
    state.billing = false; // onprem posture; the env cap must gate alone
    state.count = 0; // owns nothing — 0 >= 0 still denies
    await expect(assertCanCreateOrganization("user-1")).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("0 organizations"),
    });
  });

  it("still enforces positive caps and counts OWNED orgs only", async () => {
    process.env.MAX_ORGS_PER_USER = "1";
    state.billing = false;
    state.count = 1;
    await expect(assertCanCreateOrganization("user-7")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(state.lastWhere).toEqual({ userId: "user-7", role: "owner" });
  });

  it.each(["", "-1", "abc"])(
    "unset/negative/non-numeric (%j) means unlimited on non-billing editions",
    async (raw) => {
      if (raw === "") delete process.env.MAX_ORGS_PER_USER;
      else process.env.MAX_ORGS_PER_USER = raw;
      state.billing = false;
      state.count = 1_000_000;
      await expect(
        assertCanCreateOrganization("user-1"),
      ).resolves.toBeUndefined();
    },
  );
});

describe("canCreateOrganization (the assert as a read)", () => {
  it("maps a cap (ServiceError/QuotaExceededError) to false", async () => {
    state.count = MAX_FREE_ORGS_PER_USER; // billing on → free-org arm trips
    await expect(canCreateOrganization("user-1")).resolves.toBe(false);

    process.env.MAX_ORGS_PER_USER = "0"; // plain ServiceError arm
    state.billing = false;
    await expect(canCreateOrganization("user-1")).resolves.toBe(false);
  });

  it("maps headroom to true", async () => {
    state.count = 0;
    await expect(canCreateOrganization("user-1")).resolves.toBe(true);
  });

  it("rethrows non-ServiceError failures (infra errors are not 'capped')", async () => {
    state.countThrows = true;
    const err = await canCreateOrganization("user-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ServiceError);
    expect((err as Error).message).toBe("db unreachable");
  });
});

describe("getOrgLimits entitlement gate (via assertCanCreateSecret)", () => {
  it("never quota-gates on non-billing editions (OSS)", async () => {
    state.billing = false;
    state.secretCount = 1_000_000; // would be far over any plan cap

    await expect(assertCanCreateSecret("org-1")).resolves.toBeUndefined();
    // Fully entitled means no plan lookup and no usage counting at all.
    expect(state.orgLookups).toBe(0);
  });

  it("keeps enforcing plan quotas when billing is active", async () => {
    state.billing = true;
    state.secretCount = 1_000_000; // over the free-plan cap

    await expect(assertCanCreateSecret("org-1")).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
    expect(state.orgLookups).toBe(1);
  });

  it("reports the enterprise plan on non-billing editions", async () => {
    state.billing = false;
    const overview = await getUsageOverview("org-1");
    expect(overview.plan).toBe("enterprise");
  });
});

describe("team-tier asserts (scale, enterprise ⊇ team)", () => {
  it.each(["team", "scale", "enterprise"])(
    "allows granular access and workspace sharing on the %s plan",
    async (status) => {
      state.subscriptionStatus = status;
      await expect(
        assertCanUseGranularAccess("org-1"),
      ).resolves.toBeUndefined();
      await expect(assertCanShareWorkspace("org-1")).resolves.toBeUndefined();
    },
  );

  it.each(["free", "pro"])(
    "blocks granular access and workspace sharing on the %s plan",
    async (status) => {
      state.subscriptionStatus = status;
      await expect(assertCanUseGranularAccess("org-1")).rejects.toBeInstanceOf(
        QuotaExceededError,
      );
      // Workspace sharing throws a plain FORBIDDEN ServiceError (not a quota).
      await expect(assertCanShareWorkspace("org-1")).rejects.toThrow(
        /team plan/i,
      );
    },
  );
});

describe("assertCanCreateAgent + per-org maxAgentsOverride", () => {
  it("allows creation below the plan limit and blocks at it (no override)", async () => {
    state.subscriptionStatus = "scale"; // 50 agents
    state.agentCount = 49;
    await expect(assertCanCreateAgent("org-1")).resolves.toBeUndefined();

    state.agentCount = 50;
    try {
      await assertCanCreateAgent("org-1");
      expect.unreachable("should have thrown QuotaExceededError");
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      const quota = err as QuotaExceededError;
      expect(quota.resource).toBe("agents");
      expect(quota.current).toBe(50);
      expect(quota.limit).toBe(50);
      expect(quota.plan).toBe("scale");
    }
  });

  it("lets an override raise the cap past the plan limit", async () => {
    state.subscriptionStatus = "scale";
    state.maxAgentsOverride = 600;
    state.agentCount = 526; // far over scale's 50, under the override
    await expect(assertCanCreateAgent("org-1")).resolves.toBeUndefined();

    state.agentCount = 600;
    try {
      await assertCanCreateAgent("org-1");
      expect.unreachable("should have thrown QuotaExceededError");
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      expect((err as QuotaExceededError).limit).toBe(600);
    }
  });

  it("replaces the plan limit in both directions (an override can tighten)", async () => {
    state.subscriptionStatus = "pro"; // 3 agents
    state.maxAgentsOverride = 1;
    state.agentCount = 1;
    await expect(assertCanCreateAgent("org-1")).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
  });

  it("ENTERPRISE is uncapped by design — the org cap is VACUOUS there (sandbox step 6's recorded posture: a finite maxAgentsOverride is the required onboarding step for sales-managed orgs)", async () => {
    // Pinned deliberately: hosted agents ride this same cap (the
    // beforeCreateAgent hook), so an enterprise org — or a stolen
    // enterprise API token — has NO per-tenant bound without the override.
    // The step-6 runbook makes setting one part of enterprise onboarding.
    state.subscriptionStatus = "enterprise";
    state.agentCount = 1_000_000;
    await expect(assertCanCreateAgent("org-1")).resolves.toBeUndefined();
  });

  it("…and the override IS that onboarding mechanism: it caps an enterprise org", async () => {
    state.subscriptionStatus = "enterprise";
    state.maxAgentsOverride = 200;
    state.agentCount = 200;
    await expect(assertCanCreateAgent("org-1")).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
  });

  it("reports the overridden limit in the usage overview, other limits untouched", async () => {
    state.subscriptionStatus = "scale";
    state.maxAgentsOverride = 600;
    const overview = await getUsageOverview("org-1");
    const byName = Object.fromEntries(
      overview.resources.map((r) => [r.name, r.limit]),
    );
    expect(byName["Agents"]).toBe(600);
    expect(byName["Workspaces"]).toBe(Infinity);
    expect(byName["Secrets"]).toBe(Infinity);
  });

  it("stays fully entitled on non-billing editions, override or not", async () => {
    state.billing = false;
    state.maxAgentsOverride = 1;
    state.agentCount = 1_000_000;
    await expect(assertCanCreateAgent("org-1")).resolves.toBeUndefined();
    expect(state.orgLookups).toBe(0);
  });
});

describe("assertCanInviteMember + per-org maxMembersOverride", () => {
  it("lets an override raise the seat cap past the plan limit", async () => {
    state.subscriptionStatus = "scale"; // 25 seats
    state.maxMembersOverride = 50;
    state.count = 30; // over scale's 25, under the override
    state.inviteCount = 4;
    await expect(assertCanInviteMember("org-1")).resolves.toBeUndefined();

    // Seats count members + pending invites, so the override caps that total.
    state.count = 48;
    state.inviteCount = 2; // 50 of 50
    try {
      await assertCanInviteMember("org-1");
      expect.unreachable("should have thrown QuotaExceededError");
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      const quota = err as QuotaExceededError;
      expect(quota.resource).toBe("members");
      expect(quota.current).toBe(50);
      expect(quota.limit).toBe(50);
      expect(quota.plan).toBe("scale"); // the plan itself is unchanged
    }
  });

  it("replaces the plan limit in both directions (an override can tighten)", async () => {
    state.subscriptionStatus = "team"; // 10 seats
    state.maxMembersOverride = 2;
    state.count = 2;
    await expect(assertCanInviteMember("org-1")).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
  });

  it("can cap a plan whose seats are otherwise unlimited", async () => {
    state.subscriptionStatus = "pro"; // Infinity seats
    state.maxMembersOverride = 5;
    state.count = 5;
    await expect(assertCanInviteMember("org-1")).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
  });

  it("reports the overridden seat limit in the usage overview, others untouched", async () => {
    state.subscriptionStatus = "scale";
    state.maxMembersOverride = 50;
    state.count = 30;
    state.inviteCount = 1;
    const overview = await getUsageOverview("org-1");
    const byName = Object.fromEntries(
      overview.resources.map((r) => [r.name, r.limit]),
    );
    expect(byName["Members"]).toBe(50);
    expect(byName["Agents"]).toBe(50); // scale's plan default, not overridden
    expect(byName["Workspaces"]).toBe(Infinity);
  });

  it("is independent of the agent override", async () => {
    state.subscriptionStatus = "scale";
    state.maxAgentsOverride = 100;
    state.maxMembersOverride = 50;
    const overview = await getUsageOverview("org-1");
    const byName = Object.fromEntries(
      overview.resources.map((r) => [r.name, r.limit]),
    );
    expect(byName["Agents"]).toBe(100);
    expect(byName["Members"]).toBe(50);
  });

  it("stays fully entitled on non-billing editions, override or not", async () => {
    state.billing = false;
    state.maxMembersOverride = 1;
    state.count = 1_000_000;
    await expect(assertCanInviteMember("org-1")).resolves.toBeUndefined();
    expect(state.orgLookups).toBe(0);
  });
});
