import type Stripe from "stripe";
import { SAFE_ORG_ID } from "./plan-switch";
import { getPlanConfig, type Plan } from "./plans";
import { resolveSubscriptionPlan } from "./subscription-plan";

/**
 * A billing problem the org's admins must act on, surfaced as a dashboard
 * banner. Past-due orgs are deliberately downgraded to free by the
 * reconcile-on-read path (only active/trialing counts as live), so without
 * this the customer just sees "Free" with no idea a card failed.
 *
 * - `past_due`: Stripe is still retrying. `invoiceUrl` is the open invoice's
 *   hosted page, where the customer can enter a card AND pay in one step,
 *   which flips the subscription back to active (and the webhook restores
 *   the plan). The portal only swaps the card and leaves the invoice unpaid
 *   until the next retry, so the invoice page is the better door.
 * - `ended`: retries were exhausted and Stripe canceled the subscription for
 *   non-payment. The customer has to resubscribe from the billing page.
 */
export type PaymentIssue =
  | {
      kind: "past_due";
      plan: Plan;
      planName: string;
      /** Cents, in the account currency (Checkout bills every plan in USD). */
      amountDue: number;
      invoiceUrl: string;
    }
  | { kind: "ended"; plan: Plan; planName: string; endedAt: string };

/** How long after a payment-failure cancellation the "ended" banner shows. */
export const ENDED_BANNER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const PAST_DUE_STATUSES = new Set(["past_due", "unpaid"]);
const LIVE_STATUSES = new Set(["active", "trialing"]);

const hasLive = (subs: Stripe.Subscription[]) =>
  subs.some((s) => LIVE_STATUSES.has(s.status));

/**
 * Subscriptions (any status) on the customer the org row uniquely claims,
 * either unlabeled or labeled with this org's id. Same ownership fence as
 * findOrgLiveSubscription in plan-switch.ts: a sub labeled with ANOTHER org's
 * id is dropped, so a shared customer can't leak another org's invoice link.
 */
const listStoredCustomerSubs = async (
  stripe: Stripe,
  organizationId: string,
  storedCustomerId: string | null,
): Promise<Stripe.Subscription[]> => {
  if (!storedCustomerId) return [];
  const { data } = await stripe.subscriptions.list({
    customer: storedCustomerId,
    status: "all",
    limit: 100,
    expand: ["data.latest_invoice"],
  });
  return data.filter((sub) => {
    const owner = sub.metadata?.organizationId;
    return !owner || owner === organizationId;
  });
};

/**
 * Subscriptions labeled with this org's id anywhere in Stripe (drifted
 * customer). Degrades to none when search is unavailable or the id is unsafe
 * to put in the query grammar.
 */
const searchOrgSubs = async (
  stripe: Stripe,
  organizationId: string,
): Promise<Stripe.Subscription[]> => {
  if (!SAFE_ORG_ID.test(organizationId)) return [];
  try {
    const { data } = await stripe.subscriptions.search({
      query: `metadata['organizationId']:'${organizationId}'`,
      limit: 100,
      expand: ["data.latest_invoice"],
    });
    return data.filter((s) => s.metadata?.organizationId === organizationId);
  } catch {
    return [];
  }
};

const planOf = (sub: Stripe.Subscription) => {
  const { plan } = resolveSubscriptionPlan(sub);
  return { plan, planName: getPlanConfig(plan).name };
};

/**
 * The org's current payment problem, or null when there is none. Read-only:
 * never writes the org row (plan status stays owned by the webhook and the
 * reconcile-on-read path).
 */
export const findOrgPaymentIssue = async (
  stripe: Stripe,
  organizationId: string,
  storedCustomerId: string | null,
  now: number = Date.now(),
): Promise<PaymentIssue | null> => {
  // Healthy orgs (the common case on every dashboard load) settle on the one
  // stored-customer list call. Stripe's search API has a far tighter rate
  // limit, so it only runs when that list shows nothing live, to rule out a
  // paying sub on a drifted customer before raising a banner.
  const stored = await listStoredCustomerSubs(
    stripe,
    organizationId,
    storedCustomerId,
  );
  if (hasLive(stored)) return null;

  const byId = new Map(stored.map((s) => [s.id, s]));
  for (const s of await searchOrgSubs(stripe, organizationId)) {
    byId.set(s.id, s);
  }
  const subs = [...byId.values()];
  // A healthy subscription anywhere wins: the org is paying, nothing to say.
  if (hasLive(subs)) return null;

  const newestFirst = subs.sort((a, b) => b.created - a.created);

  for (const sub of newestFirst) {
    if (!PAST_DUE_STATUSES.has(sub.status)) continue;
    const invoice = sub.latest_invoice;
    if (
      invoice &&
      typeof invoice === "object" &&
      invoice.status === "open" &&
      invoice.hosted_invoice_url?.startsWith("https://") &&
      invoice.amount_remaining > 0
    ) {
      return {
        kind: "past_due",
        ...planOf(sub),
        amountDue: invoice.amount_remaining,
        invoiceUrl: invoice.hosted_invoice_url,
      };
    }
  }

  // Only the newest subscription decides "ended": an old dunning cancel
  // followed by a deliberate cancel of a later sub is not a payment problem.
  const newest = newestFirst[0];
  if (
    newest &&
    newest.status === "canceled" &&
    newest.cancellation_details?.reason === "payment_failed" &&
    newest.ended_at &&
    now - newest.ended_at * 1000 <= ENDED_BANNER_WINDOW_MS
  ) {
    return {
      kind: "ended",
      ...planOf(newest),
      endedAt: new Date(newest.ended_at * 1000).toISOString(),
    };
  }

  return null;
};
