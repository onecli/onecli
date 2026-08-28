import { describe, expect, it, vi } from "vitest";

// CAPS is resolved at module load — pin the onprem (no-billing) edition.
vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_EDITION;
});

const state = vi.hoisted(() => ({ resolutions: 0 }));

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

vi.mock("@onecli/db", () => ({ db: {} }));

import { checkDashboardRedirect } from "./user-plan";

describe("checkDashboardRedirect (onprem)", () => {
  it("is a hard no-op without billing — no resolution, no redirect", async () => {
    await expect(checkDashboardRedirect()).resolves.toBeNull();
    expect(state.resolutions).toBe(0);
  });
});
