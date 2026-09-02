import type Stripe from "stripe";
import type { Plan } from "./plans";
import { findKnownBaseItem } from "./plan-switch";
import { PRICE_TO_PLAN } from "./price-map";

/**
 * Resolve the plan a live subscription sits on, plus the item carrying it.
 *
 * A subscription can hold add-on / metered items alongside its base plan, so we
 * locate the item whose price is a *known plan price* (via
 * {@link findKnownBaseItem}) rather than trusting `items.data[0]` — after a
 * Stripe price swap the base item isn't guaranteed to be first. A subscription
 * with no recognizable base price falls back to "pro", matching the billing
 * page's lazy reconcile so the webhook and the page can't drift.
 *
 * The "pro" fallback is LOAD-BEARING for real customers: live subscriptions
 * still bill on the archived "Pro (Early Access)" $29 price, which has no
 * config slot and resolves correctly only through this fallback (verified
 * against live Stripe, 2026-07). Never change it to "free".
 *
 * `priceToPlan` defaults to the canonical {@link PRICE_TO_PLAN} and exists only
 * as a test seam — production callers must use the default. A single shared map
 * is what keeps plans from drifting by code path, so the known base price ids
 * are derived from it here rather than accepted separately.
 */
export const resolveSubscriptionPlan = (
  subscription: Stripe.Subscription,
  priceToPlan: Record<string, Plan> = PRICE_TO_PLAN,
): { plan: Plan; baseItem: Stripe.SubscriptionItem | undefined } => {
  const baseItem = findKnownBaseItem(subscription, Object.keys(priceToPlan));
  return {
    plan: baseItem ? (priceToPlan[baseItem.price.id] ?? "pro") : "pro",
    baseItem,
  };
};
