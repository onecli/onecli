import { beforeEach, describe, expect, it, vi } from "vitest";

// CAPS is resolved at module load — pin the onprem (no-billing) edition.
vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_EDITION;
});

const state = vi.hoisted(() => ({
  context: null as {
    userId: string;
    organizationId: string;
    role: string;
  } | null,
  onboardingCompletedAt: null as Date | null,
  orgQueries: 0,
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
      findUnique: async () => ({
        onboardingCompletedAt: state.onboardingCompletedAt,
      }),
    },
    organization: {
      findUnique: async () => {
        state.orgQueries += 1;
        return { subscriptionStatus: "free" };
      },
    },
  },
}));

import { checkDashboardRedirect } from "./user-plan";

const OWNER = { userId: "u1", organizationId: "org1", role: "owner" };

beforeEach(() => {
  state.context = { ...OWNER };
  state.onboardingCompletedAt = null;
  state.orgQueries = 0;
});

/**
 * Self-host runs the same first-login walkthrough as cloud: a fresh org owner
 * is routed into /onboarding until they create an agent or skip. The only
 * billing-flavored input (the paid-org exemption) is never read here.
 */
describe("checkDashboardRedirect (onprem)", () => {
  it("routes an OWNER who never onboarded into /onboarding", async () => {
    await expect(checkDashboardRedirect()).resolves.toBe("/onboarding");
    // No subscription lookup without billing: every org reads as free.
    expect(state.orgQueries).toBe(0);
  });

  it("leaves an owner who completed onboarding alone", async () => {
    state.onboardingCompletedAt = new Date();
    await expect(checkDashboardRedirect()).resolves.toBeNull();
  });

  it("never routes an invited member or admin into onboarding", async () => {
    state.context = { ...OWNER, role: "member" };
    await expect(checkDashboardRedirect()).resolves.toBeNull();
    state.context = { ...OWNER, role: "admin" };
    await expect(checkDashboardRedirect()).resolves.toBeNull();
  });

  it("answers null when org context cannot resolve", async () => {
    state.context = null;
    await expect(checkDashboardRedirect()).resolves.toBeNull();
  });
});
