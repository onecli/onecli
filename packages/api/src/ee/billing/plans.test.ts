import { describe, expect, it } from "vitest";

import {
  ENTERPRISE_PLAN_CONFIG,
  PLANS,
  getPlanConfig,
  isPaidPlan,
  isPlanAtLeast,
  isSalesManagedPlan,
  normalizePlan,
  offeredPlans,
  planRank,
} from "./plans";
import { requiredPlanFor } from "./plan-features";

describe("normalizePlan", () => {
  it("maps every known status to itself", () => {
    expect(normalizePlan("free")).toBe("free");
    expect(normalizePlan("pro")).toBe("pro");
    expect(normalizePlan("team")).toBe("team");
    expect(normalizePlan("team-legacy")).toBe("team-legacy");
    expect(normalizePlan("scale")).toBe("scale");
    expect(normalizePlan("enterprise")).toBe("enterprise");
  });

  it("still coerces unknown statuses to free", () => {
    expect(normalizePlan("")).toBe("free");
    expect(normalizePlan("business")).toBe("free");
    expect(normalizePlan("ENTERPRISE")).toBe("free");
  });
});

describe("plan ranking", () => {
  it("orders free < pro < team < scale < enterprise", () => {
    expect(planRank("free")).toBeLessThan(planRank("pro"));
    expect(planRank("pro")).toBeLessThan(planRank("team"));
    expect(planRank("team")).toBeLessThan(planRank("scale"));
    expect(planRank("scale")).toBeLessThan(planRank("enterprise"));
  });

  it("ties team-legacy with team (legacy orgs keep team features, neither reads as a downgrade)", () => {
    expect(planRank("team-legacy")).toBe(planRank("team"));
    expect(isPlanAtLeast("team-legacy", "team")).toBe(true);
    expect(isPlanAtLeast("team", "team-legacy")).toBe(true);
    expect(isPlanAtLeast("team-legacy", "scale")).toBe(false);
  });

  it("treats scale and enterprise as at least team (team features stay unlocked)", () => {
    expect(isPlanAtLeast("scale", "team")).toBe(true);
    expect(isPlanAtLeast("enterprise", "team")).toBe(true);
    expect(isPlanAtLeast("enterprise", "pro")).toBe(true);
    expect(isPlanAtLeast("team", "scale")).toBe(false);
    expect(isPlanAtLeast("team", "enterprise")).toBe(false);
  });
});

describe("getPlanConfig", () => {
  it("resolves the enterprise config instead of falling back to free", () => {
    const config = getPlanConfig("enterprise");
    expect(config).toBe(ENTERPRISE_PLAN_CONFIG);
    expect(config.id).toBe("enterprise");
    expect(config.name).toBe("Enterprise");
  });

  it("grants unlimited quotas with 90-day audit logs", () => {
    const { limits } = getPlanConfig("enterprise");
    expect(limits.maxAgents).toBe(Infinity);
    expect(limits.maxWorkspaces).toBe(Infinity);
    expect(limits.maxIntegrationCalls).toBe(Infinity);
    expect(limits.auditLogDays).toBe(90);
  });
});

describe("agent hard caps", () => {
  it("caps agents per tier (no overage anywhere)", () => {
    expect(getPlanConfig("free").limits.maxAgents).toBe(2);
    expect(getPlanConfig("pro").limits.maxAgents).toBe(3);
    expect(getPlanConfig("team").limits.maxAgents).toBe(10);
    expect(getPlanConfig("team-legacy").limits.maxAgents).toBe(20);
    expect(getPlanConfig("scale").limits.maxAgents).toBe(20);
    expect(getPlanConfig("enterprise").limits.maxAgents).toBe(Infinity);
  });
});

describe("seat caps", () => {
  it("caps human seats per tier (retired pro stays uncapped)", () => {
    expect(getPlanConfig("free").limits.maxMembers).toBe(3);
    expect(getPlanConfig("pro").limits.maxMembers).toBe(Infinity);
    expect(getPlanConfig("team").limits.maxMembers).toBe(5);
    expect(getPlanConfig("team-legacy").limits.maxMembers).toBe(10);
    expect(getPlanConfig("scale").limits.maxMembers).toBe(10);
    expect(getPlanConfig("enterprise").limits.maxMembers).toBe(Infinity);
  });
});

describe("pricing", () => {
  it("prices the tiers per the Aug 2026 model (BYOC prices)", () => {
    expect(getPlanConfig("pro").price).toBe(25);
    expect(getPlanConfig("team").price).toBe(149);
    expect(getPlanConfig("team-legacy").price).toBe(199);
    expect(getPlanConfig("scale").price).toBe(499);
  });

  it("yearly = pay 10 months for 12 on every self-serve paid tier", () => {
    for (const plan of PLANS.filter((p) => p.id !== "free")) {
      expect(plan.yearlyPrice).toBe(plan.price * 10);
    }
  });
});

describe("self-serve surface", () => {
  it("keeps enterprise OUT of the purchasable PLANS grid, rank-ordered", () => {
    expect(PLANS).toHaveLength(5);
    expect(PLANS.map((p) => p.id)).toEqual([
      "free",
      "pro",
      "team",
      "team-legacy",
      "scale",
    ]);
  });

  it("offers retired plans only to orgs already on them", () => {
    expect(offeredPlans("pro").map((p) => p.id)).toEqual([
      "free",
      "pro",
      "team",
      "scale",
    ]);
    expect(offeredPlans("team-legacy").map((p) => p.id)).toEqual([
      "free",
      "team",
      "team-legacy",
      "scale",
    ]);
    for (const plan of ["free", "team", "scale", "enterprise"] as const) {
      expect(offeredPlans(plan).map((p) => p.id)).toEqual([
        "free",
        "team",
        "scale",
      ]);
    }
  });

  it("marks only enterprise as sales-managed", () => {
    expect(isSalesManagedPlan("enterprise")).toBe(true);
    expect(isSalesManagedPlan("free")).toBe(false);
    expect(isSalesManagedPlan("pro")).toBe(false);
    expect(isSalesManagedPlan("team")).toBe(false);
    expect(isSalesManagedPlan("team-legacy")).toBe(false);
    expect(isSalesManagedPlan("scale")).toBe(false);
  });

  it("counts enterprise as a paid plan", () => {
    expect(isPaidPlan("enterprise")).toBe(true);
    expect(isPaidPlan("free")).toBe(false);
  });
});

describe("premium feature gating", () => {
  it("maps each premium feature to its required plan", () => {
    // Pins the tier moves in this release: the route tests mock
    // assertFeatureAllowed, so a regression of these map values would otherwise
    // go uncaught.
    expect(requiredPlanFor("sso")).toBe("enterprise"); // moved Scale -> Enterprise (July 2026)
    expect(requiredPlanFor("policy.manual_approval")).toBe("team"); // moved Pro -> Team
    expect(requiredPlanFor("policy.rate_limit")).toBe("pro");
    expect(requiredPlanFor("policy.deny_mode")).toBe("team");
    expect(requiredPlanFor("groups")).toBe("enterprise");
  });
});
