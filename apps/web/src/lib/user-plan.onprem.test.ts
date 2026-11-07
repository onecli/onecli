import { beforeEach, describe, expect, it, vi } from "vitest";

// CAPS is resolved at module load — pin the onprem (no-billing) edition.
vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_EDITION;
});

const state = vi.hoisted(() => ({
  resolutions: 0,
  userQueries: 0,
  orgQueries: 0,
}));

vi.mock("@/lib/actions/resolve-user", () => ({
  resolveOrgContextWithRole: async () => {
    state.resolutions += 1;
    return {
      userId: "u1",
      userEmail: "u@example.test",
      organizationId: "org1",
      role: "owner",
    };
  },
}));

vi.mock("@onecli/db", () => ({
  db: {
    user: {
      findUnique: async () => {
        state.userQueries += 1;
        return { onboardingCompletedAt: null };
      },
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

beforeEach(() => {
  state.resolutions = 0;
  state.userQueries = 0;
  state.orgQueries = 0;
});

/**
 * Onboarding is cloud-only: a self-hosted owner lands on the dashboard, never
 * in the first-login walkthrough, even a fresh owner who never onboarded.
 */
describe("checkDashboardRedirect (onprem)", () => {
  it("is a hard no-op without billing: no resolution, no query, no redirect", async () => {
    // MUTATION-TESTED (the onprem guard): drop the !CAPS.billing early return
    // and this fresh, never-onboarded OWNER is routed into /onboarding, the
    // self-hosted first login this guard exists to keep on the dashboard.
    await expect(checkDashboardRedirect()).resolves.toBeNull();
    expect(state.resolutions).toBe(0);
    expect(state.userQueries).toBe(0);
    expect(state.orgQueries).toBe(0);
  });
});
