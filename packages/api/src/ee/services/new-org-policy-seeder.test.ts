import { beforeEach, describe, expect, it, vi } from "vitest";

// The seeded birth posture had ZERO test pins when it was block — a silent
// regression risk in either direction. This pins the step-3 decision
// (plans/project-attach-model.md round 5): a brand-new org's Default Rule is
// ALLOW; deny-by-default is the org admin's opt-in flip, never the birth state.

const state = vi.hoisted(() => ({
  calls: [] as { scope: unknown; rules: Record<string, unknown>[] }[],
}));

vi.mock("../../services/policy-service", () => ({
  backfillPublishScope: async (
    scope: unknown,
    rules: Record<string, unknown>[],
  ) => {
    state.calls.push({ scope, rules });
    return { skipped: false, generation: 1, ruleCount: rules.length };
  },
}));

const { eeNewOrgPolicySeeder } = await import("./new-org-policy-seeder");

beforeEach(() => {
  state.calls = [];
});

describe("the new-org seeded posture", () => {
  it("seeds exactly one org Default Rule with action ALLOW", async () => {
    await eeNewOrgPolicySeeder.seed("org-x");
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.scope).toEqual({ organizationId: "org-x" });
    expect(state.calls[0]?.rules).toHaveLength(1);
    expect(state.calls[0]?.rules[0]).toMatchObject({
      isDefault: true,
      source: "default",
      name: "Default Rule",
      action: "allow",
      priority: 0,
      requireApproval: false,
      identities: [],
      targets: [],
    });
  });

  it("seeds the org scope regardless of the default workspace passed by the seam", async () => {
    await eeNewOrgPolicySeeder.seed("org-y", "workspace-z");
    expect(state.calls[0]?.scope).toEqual({ organizationId: "org-y" });
  });
});
