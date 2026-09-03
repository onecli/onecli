import type { BillingInterval, Plan } from "./plans";
import { STRIPE_PRO_PRICE_ID } from "../../lib/env";

export const STRIPE_PRO_YEARLY_PRICE_ID =
  process.env.STRIPE_PRO_YEARLY_PRICE_ID ?? "";

export const STRIPE_TEAM_BASE_PRICE_ID =
  process.env.STRIPE_TEAM_BASE_PRICE_ID ?? "";

export const STRIPE_TEAM_YEARLY_PRICE_ID =
  process.env.STRIPE_TEAM_YEARLY_PRICE_ID ?? "";

// The Aug-2026-retired Team prices ($199/mo, $1,990/yr). Live subscriptions
// keep billing on them; mapping them keeps those orgs resolving to
// "team-legacy" (their grandfathered limits).
export const STRIPE_TEAM_LEGACY_199_PRICE_ID =
  process.env.STRIPE_TEAM_LEGACY_199_PRICE_ID ?? "";

export const STRIPE_TEAM_LEGACY_199_YEARLY_PRICE_ID =
  process.env.STRIPE_TEAM_LEGACY_199_YEARLY_PRICE_ID ?? "";

// The pre-July-2026 Team price ($200/mo). Grandfathered subscriptions keep
// billing on it until they next switch plans; mapping it keeps them
// resolving to "team-legacy".
export const STRIPE_TEAM_LEGACY_PRICE_ID =
  process.env.STRIPE_TEAM_LEGACY_PRICE_ID ?? "";

// The hosted "models included" Team prices ($499/mo, $4,990/yr — Aug 2026
// structure). Sales-managed until the platform provides hosted models:
// subscriptions on them are created from the Stripe dashboard for negotiated
// deals, never via self-serve checkout.
export const STRIPE_TEAM_HOSTED_PRICE_ID =
  process.env.STRIPE_TEAM_HOSTED_PRICE_ID ?? "";

export const STRIPE_TEAM_HOSTED_YEARLY_PRICE_ID =
  process.env.STRIPE_TEAM_HOSTED_YEARLY_PRICE_ID ?? "";

export const STRIPE_SCALE_PRICE_ID = process.env.STRIPE_SCALE_PRICE_ID ?? "";

export const STRIPE_SCALE_YEARLY_PRICE_ID =
  process.env.STRIPE_SCALE_YEARLY_PRICE_ID ?? "";

// Managed self-hosting in the customer's VPC. Sales-managed: subscriptions
// on these prices are created from the Stripe dashboard, never self-serve.
export const STRIPE_SCALE_SELF_HOSTED_PRICE_ID =
  process.env.STRIPE_SCALE_SELF_HOSTED_PRICE_ID ?? "";

export const STRIPE_SCALE_SELF_HOSTED_YEARLY_PRICE_ID =
  process.env.STRIPE_SCALE_SELF_HOSTED_YEARLY_PRICE_ID ?? "";

// Sales-managed tier: subscriptions on this price are created from the
// Stripe dashboard. Empty = the enterprise mapping is disabled.
export const STRIPE_ENTERPRISE_PRICE_ID =
  process.env.STRIPE_ENTERPRISE_PRICE_ID ?? "";

/** Plans purchasable via self-serve checkout. */
export type SelfServePlan = Exclude<
  Plan,
  "free" | "enterprise" | "aws-marketplace"
>;

/** Self-serve base price ids by plan and billing interval. */
export const PLAN_PRICE_IDS: Record<
  SelfServePlan,
  Record<BillingInterval, string>
> = {
  pro: { month: STRIPE_PRO_PRICE_ID, year: STRIPE_PRO_YEARLY_PRICE_ID },
  team: {
    month: STRIPE_TEAM_BASE_PRICE_ID,
    year: STRIPE_TEAM_YEARLY_PRICE_ID,
  },
  // Retired plans stay here so grandfathered orgs can still switch billing
  // intervals; the checkout route's retired-plan guard rejects everyone else.
  "team-legacy": {
    month: STRIPE_TEAM_LEGACY_199_PRICE_ID,
    year: STRIPE_TEAM_LEGACY_199_YEARLY_PRICE_ID,
  },
  scale: {
    month: STRIPE_SCALE_PRICE_ID,
    year: STRIPE_SCALE_YEARLY_PRICE_ID,
  },
};

/**
 * Prices whose subscriptions are managed by sales/ops from the Stripe
 * dashboard. Self-serve checkout, plan switches and previews must reject a
 * subscription holding any of these — otherwise a managed customer (e.g.
 * self-hosted Scale) could switch themselves onto a cheaper self-serve plan.
 */
export const SALES_MANAGED_PRICE_IDS: string[] = [
  STRIPE_ENTERPRISE_PRICE_ID,
  STRIPE_SCALE_SELF_HOSTED_PRICE_ID,
  STRIPE_SCALE_SELF_HOSTED_YEARLY_PRICE_ID,
  STRIPE_TEAM_HOSTED_PRICE_ID,
  STRIPE_TEAM_HOSTED_YEARLY_PRICE_ID,
].filter((id) => id.length > 0);

export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
