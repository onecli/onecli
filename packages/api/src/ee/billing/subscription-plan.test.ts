import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import type { Plan } from "./plans";
import { resolveSubscriptionPlan } from "./subscription-plan";

// The env-built PRICE_TO_PLAN is empty under test (no price-id env vars set), so
// we inject an explicit map. resolveSubscriptionPlan derives its known base
// price ids from the map's keys, mirroring how production binds the canonical
// map by default.
const PRICE_TO_PLAN: Record<string, Plan> = {
  price_pro: "pro",
  price_team: "team",
  price_scale: "scale",
};

const sub = (priceIds: string[]): Stripe.Subscription =>
  ({
    items: {
      data: priceIds.map((id, i) => ({ id: `si_${i}`, price: { id } })),
    },
  }) as unknown as Stripe.Subscription;

describe("resolveSubscriptionPlan", () => {
  it("maps a single base item to its plan", () => {
    const { plan, baseItem } = resolveSubscriptionPlan(
      sub(["price_team"]),
      PRICE_TO_PLAN,
    );
    expect(plan).toBe("team");
    expect(baseItem?.id).toBe("si_0");
  });

  it("finds the base plan even when an add-on item is listed first", () => {
    // After a Stripe price swap the base item isn't guaranteed to be
    // items.data[0]; the resolver must scan for the known plan price, not trust
    // position.
    const { plan, baseItem } = resolveSubscriptionPlan(
      sub(["price_addon", "price_scale"]),
      PRICE_TO_PLAN,
    );
    expect(plan).toBe("scale");
    expect(baseItem?.id).toBe("si_1");
  });

  it("resolves a retired-but-mapped legacy price to its plan", () => {
    // Grandfathered subs keep billing on retired prices; those ids stay in
    // PRICE_TO_PLAN (the legacy slots) precisely so this resolves to
    // "team-legacy" (the grandfathered limits) instead of falling through to
    // the "pro" fallback below.
    const { plan, baseItem } = resolveSubscriptionPlan(
      sub(["price_team_legacy"]),
      { ...PRICE_TO_PLAN, price_team_legacy: "team-legacy" },
    );
    expect(plan).toBe("team-legacy");
    expect(baseItem?.id).toBe("si_0");
  });

  it("falls back to pro when no item matches a known plan price", () => {
    const { plan, baseItem } = resolveSubscriptionPlan(
      sub(["price_unknown"]),
      PRICE_TO_PLAN,
    );
    expect(plan).toBe("pro");
    expect(baseItem).toBeUndefined();
  });

  it("falls back to pro for a subscription with no items", () => {
    const { plan, baseItem } = resolveSubscriptionPlan(sub([]), PRICE_TO_PLAN);
    expect(plan).toBe("pro");
    expect(baseItem).toBeUndefined();
  });
});
