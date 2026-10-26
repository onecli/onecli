import { describe, expect, it, vi } from "vitest";
import type { Plan } from "./plans";
import { buildPriceToPlan } from "./price-map";

describe("buildPriceToPlan", () => {
  it("maps configured price ids to plans", () => {
    expect(
      buildPriceToPlan([
        ["price_pro", "pro"],
        ["price_team", "team"],
        ["price_ent", "enterprise"],
      ]),
    ).toEqual({
      price_pro: "pro",
      price_team: "team",
      price_ent: "enterprise",
    });
  });

  it("skips unset ids instead of creating an empty-string key", () => {
    const map = buildPriceToPlan([
      ["price_pro", "pro"],
      ["", "team"],
      ["", "enterprise"],
    ]);
    expect(map).toEqual({ price_pro: "pro" });
    expect(Object.keys(map)).not.toContain("");
    expect(map[""]).toBeUndefined();
  });

  it("maps every production price slot onto its plan (PRICE_TO_PLAN)", async () => {
    // The real map, not a hand-built mirror: each env slot gets a distinct
    // sentinel, so a slot remapped (e.g. a retired $199 price to "team") or
    // dropped fails here. A live price left unmapped would silently resolve
    // its orgs to the "pro" fallback and rewrite their plan.
    const slots = {
      STRIPE_PRO_PRICE_ID: "pro",
      STRIPE_PRO_YEARLY_PRICE_ID: "pro",
      STRIPE_TEAM_BASE_PRICE_ID: "team",
      STRIPE_TEAM_YEARLY_PRICE_ID: "team",
      STRIPE_TEAM_HOSTED_PRICE_ID: "team",
      STRIPE_TEAM_HOSTED_YEARLY_PRICE_ID: "team",
      STRIPE_TEAM_LEGACY_199_PRICE_ID: "team-legacy",
      STRIPE_TEAM_LEGACY_199_YEARLY_PRICE_ID: "team-legacy",
      STRIPE_TEAM_LEGACY_PRICE_ID: "team-legacy",
      STRIPE_SCALE_PRICE_ID: "scale",
      STRIPE_SCALE_YEARLY_PRICE_ID: "scale",
      STRIPE_SCALE_SELF_HOSTED_PRICE_ID: "scale",
      STRIPE_SCALE_SELF_HOSTED_YEARLY_PRICE_ID: "scale",
      STRIPE_ENTERPRISE_PRICE_ID: "enterprise",
    } as const satisfies Record<string, Plan>;
    for (const name of Object.keys(slots)) {
      vi.stubEnv(name, `price_${name.toLowerCase()}`);
    }
    try {
      vi.resetModules();
      const { PRICE_TO_PLAN, KNOWN_BASE_PRICE_IDS } =
        await import("./price-map");
      const expected = Object.fromEntries(
        Object.entries(slots).map(([name, plan]) => [
          `price_${name.toLowerCase()}`,
          plan,
        ]),
      );
      expect(PRICE_TO_PLAN).toEqual(expected);
      expect([...KNOWN_BASE_PRICE_IDS].sort()).toEqual(
        Object.keys(expected).sort(),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
