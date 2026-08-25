import type { Plan } from "./plans";
import { STRIPE_PRO_PRICE_ID } from "../../lib/env";
import {
  STRIPE_ENTERPRISE_PRICE_ID,
  STRIPE_PRO_YEARLY_PRICE_ID,
  STRIPE_SCALE_PRICE_ID,
  STRIPE_SCALE_SELF_HOSTED_PRICE_ID,
  STRIPE_SCALE_SELF_HOSTED_YEARLY_PRICE_ID,
  STRIPE_SCALE_YEARLY_PRICE_ID,
  STRIPE_TEAM_BASE_PRICE_ID,
  STRIPE_TEAM_HOSTED_PRICE_ID,
  STRIPE_TEAM_HOSTED_YEARLY_PRICE_ID,
  STRIPE_TEAM_LEGACY_199_PRICE_ID,
  STRIPE_TEAM_LEGACY_199_YEARLY_PRICE_ID,
  STRIPE_TEAM_LEGACY_PRICE_ID,
  STRIPE_TEAM_YEARLY_PRICE_ID,
} from "./env";

/**
 * The single Stripe-price → plan mapping. Stripe is the source of truth for
 * `Organization.subscriptionStatus` (webhooks write it, the billing
 * reconcile-on-read converges it) — every consumer must share this map or
 * plans drift by code path.
 *
 * Unset ids are skipped: an empty-string key would otherwise map Stripe
 * items with missing price ids to whichever plan spread last.
 */
export const buildPriceToPlan = (
  entries: [priceId: string, plan: Plan][],
): Record<string, Plan> =>
  Object.fromEntries(entries.filter(([priceId]) => priceId.length > 0));

export const PRICE_TO_PLAN: Record<string, Plan> = buildPriceToPlan([
  [STRIPE_PRO_PRICE_ID, "pro"],
  [STRIPE_PRO_YEARLY_PRICE_ID, "pro"],
  // The Aug-2026 BYOC Team prices ($149/mo, $1,490/yr) — what checkout sells.
  [STRIPE_TEAM_BASE_PRICE_ID, "team"],
  [STRIPE_TEAM_YEARLY_PRICE_ID, "team"],
  // Hosted "models included" Team prices ($499/mo, $4,990/yr) — same plan
  // limits, sales-managed until the platform provides hosted models.
  [STRIPE_TEAM_HOSTED_PRICE_ID, "team"],
  [STRIPE_TEAM_HOSTED_YEARLY_PRICE_ID, "team"],
  // Retired Team prices. Subscriptions keep billing on a retired price until
  // they next switch plans, so a retired price must stay mapped while ANY
  // live subscription holds it — dropping a live price id silently resolves
  // those orgs to the "pro" fallback and rewrites their plan in the DB.
  // Live-Stripe audit 2026-08-24: 6 subs on $199/mo, 3 on $200/mo.
  [STRIPE_TEAM_LEGACY_199_PRICE_ID, "team-legacy"],
  [STRIPE_TEAM_LEGACY_199_YEARLY_PRICE_ID, "team-legacy"],
  // Pre-July-2026 $200/mo Team price.
  [STRIPE_TEAM_LEGACY_PRICE_ID, "team-legacy"],
  [STRIPE_SCALE_PRICE_ID, "scale"],
  [STRIPE_SCALE_YEARLY_PRICE_ID, "scale"],
  // Managed self-hosting (sales-managed, dashboard-created).
  [STRIPE_SCALE_SELF_HOSTED_PRICE_ID, "scale"],
  [STRIPE_SCALE_SELF_HOSTED_YEARLY_PRICE_ID, "scale"],
  // Sales-managed: subscriptions on this price are created from the Stripe
  // dashboard, never via self-serve checkout.
  [STRIPE_ENTERPRISE_PRICE_ID, "enterprise"],
]);

/** Base price ids this deployment recognizes. */
export const KNOWN_BASE_PRICE_IDS = Object.keys(PRICE_TO_PLAN);
