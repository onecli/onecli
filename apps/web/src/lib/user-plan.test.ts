import { beforeEach, describe, expect, it, vi } from "vitest";

// CAPS is resolved at module load — pin the billing edition before imports.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

const state = vi.hoisted(() => ({
  context: null as {
    userId: string;
    organizationId: string;
    role: string;
  } | null,
  onboardingCompletedAt: null as Date | null,
  subscriptionStatus: "free" as string,
  userQueries: 0,
}));

vi.mock("@/lib/actions/resolve-user", () => ({
  resolveOrgContextWithRole: async () => {
    if (!state.context) throw new Error("Not authenticated");
    return { ...state.context, userEmail: "u@example.test" };
  },
}));

vi.mock("@onecli/db", () => ({
  db: {
    user: {
      findUnique: async () => {
        state.userQueries += 1;
        return { onboardingCompletedAt: state.onboardingCompletedAt };
      },
    },
    organization: {
      findUnique: async () => ({
        subscriptionStatus: state.subscriptionStatus,
      }),
    },
  },
}));

import { checkDashboardRedirect } from "./user-plan";

const OWNER = { userId: "u1", organizationId: "org1", role: "owner" };

beforeEach(() => {
  state.context = { ...OWNER };
  state.onboardingCompletedAt = null;
  state.subscriptionStatus = "free";
  state.userQueries = 0;
});

describe("checkDashboardRedirect (billing edition)", () => {
  it("routes a free-org OWNER who never onboarded into /onboarding", async () => {
    await expect(checkDashboardRedirect()).resolves.toBe("/onboarding");
  });

  it("never routes an invited-role MEMBER into onboarding", async () => {
    // MUTATION-TESTED (the owner gate): drop the role check and every
    // invited or directory-provisioned member of a free org is bounced into
    // the org creator's install walkthrough — the flow that looped live.
    state.context = { ...OWNER, role: "member" };
    await expect(checkDashboardRedirect()).resolves.toBeNull();
    // The gate short-circuits before any user/org query runs.
    expect(state.userQueries).toBe(0);
  });

  it("never routes an admin into onboarding", async () => {
    state.context = { ...OWNER, role: "admin" };
    await expect(checkDashboardRedirect()).resolves.toBeNull();
  });

  it("leaves a paid org's owner alone", async () => {
    state.subscriptionStatus = "team";
    await expect(checkDashboardRedirect()).resolves.toBeNull();
  });

  it("leaves a grandfathered team-legacy org's owner alone", async () => {
    state.subscriptionStatus = "team-legacy";
    await expect(checkDashboardRedirect()).resolves.toBeNull();
  });

  it("leaves an owner who completed onboarding alone", async () => {
    state.onboardingCompletedAt = new Date();
    await expect(checkDashboardRedirect()).resolves.toBeNull();
  });

  it("answers null when org context cannot resolve (no session, no headers)", async () => {
    state.context = null;
    await expect(checkDashboardRedirect()).resolves.toBeNull();
  });
});
