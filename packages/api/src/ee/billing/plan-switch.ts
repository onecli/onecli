import type Stripe from "stripe";

export interface PlanSwitchItem {
  id?: string;
  price?: string;
  quantity?: number;
  deleted?: boolean;
}

/**
 * Finds the organization's active (or trialing) subscription among the
 * customer's subscriptions. Matches on subscription metadata so a customer
 * shared across orgs never picks up another org's subscription.
 */
export const findActivePlanSubscription = async (
  stripe: Stripe,
  customerId: string,
  organizationId: string,
): Promise<Stripe.Subscription | undefined> => {
  const existing = await stripe.subscriptions.list({
    customer: customerId,
    limit: 100,
  });

  return existing.data.find(
    (s) =>
      (s.status === "active" || s.status === "trialing") &&
      s.metadata.organizationId === organizationId,
  );
};

/**
 * Stripe's search query language is a string grammar, and `organizationId`
 * reaches it from subscription metadata as well as our own auth context. Ids
 * we mint are server-generated (uuid / better-auth slugs), so this is defense
 * in depth rather than a live hole: a value containing a quote or backslash
 * would otherwise break out of the quoted literal and change which
 * subscriptions the query returns — i.e. which org's plan we read. Reject
 * anything that isn't a plain id instead of trying to escape it.
 */
const SAFE_ORG_ID = /^[A-Za-z0-9_-]+$/;

interface OrgSubscriptionMatch {
  subscription: Stripe.Subscription;
  /** The customer actually billing it — what `stripeCustomerId` should say. */
  customerId: string;
}

const isLive = (s: Stripe.Subscription) =>
  s.status === "active" || s.status === "trialing";

// A subscription's `customer` is an id, an expanded object, or (deleted
// customer / trimmed webhook payload) absent — never assume it dereferences.
const customerOf = (s: Stripe.Subscription): string | undefined =>
  typeof s.customer === "string" ? s.customer : s.customer?.id;

/**
 * Live subscriptions on the org's stored customer, split by how surely they
 * belong to the org. `labeled` carries this org's id in metadata — the same
 * fence as {@link findActivePlanSubscription}. `unlabeled` carries NO
 * organizationId at all: dashboard/ops-created subscriptions (live prod
 * example: the PO-billed enterprise sub, 2026-09 audit) never got the
 * metadata, and `Organization.stripeCustomerId` is `@unique`, so the org
 * whose row points at this customer is its one legitimate claimant. A sub
 * explicitly labeled with ANOTHER org's id is neither — fenced out entirely.
 *
 * Dropping unlabeled subs is not an option: the reconcile-on-read paths would
 * read "no subscription" for a paying dashboard-managed org and write it down
 * to free — the exact downgrade this module exists to prevent.
 */
const listStoredCustomerMatches = async (
  stripe: Stripe,
  organizationId: string,
  storedCustomerId: string,
): Promise<{
  labeled: OrgSubscriptionMatch[];
  unlabeled: OrgSubscriptionMatch[];
}> => {
  const existing = await stripe.subscriptions.list({
    customer: storedCustomerId,
    limit: 100,
  });

  const labeled: OrgSubscriptionMatch[] = [];
  const unlabeled: OrgSubscriptionMatch[] = [];
  for (const subscription of existing.data) {
    if (!isLive(subscription)) continue;
    const owner = subscription.metadata?.organizationId;
    const match = {
      subscription,
      customerId: customerOf(subscription) ?? storedCustomerId,
    };
    if (owner === organizationId) labeled.push(match);
    else if (!owner) unlabeled.push(match);
    // Explicitly another org's: a shared customer must never leak its plan.
  }
  return { labeled, unlabeled };
};

/**
 * Live subscriptions carrying this org's id in metadata, anywhere in Stripe.
 * The search index is eventually consistent (~a minute), so this can miss a
 * just-created subscription and still return a just-canceled one — callers
 * that act on the result must re-check liveness (or filter known-dead ids).
 * Unavailable or unsafe-to-query degrades to "none found".
 */
const searchOrgSubscriptions = async (
  stripe: Stripe,
  organizationId: string,
): Promise<OrgSubscriptionMatch[]> => {
  if (!SAFE_ORG_ID.test(organizationId)) return [];

  try {
    const found = await stripe.subscriptions.search({
      query: `metadata['organizationId']:'${organizationId}'`,
      limit: 100,
    });
    // Re-check the org id locally instead of trusting the query alone. The
    // whole point of findActivePlanSubscription's metadata filter is that a
    // customer can be shared across orgs; a search result must clear the same
    // bar before it can become this org's plan.
    return found.data.flatMap((s) => {
      if (!isLive(s) || s.metadata?.organizationId !== organizationId) {
        return [];
      }
      const customerId = customerOf(s);
      return customerId ? [{ subscription: s, customerId }] : [];
    });
  } catch {
    // Search unavailable (or not enabled): fall through to "none found".
    // Callers treat that as the stored-customer answer, which is the
    // pre-existing behavior.
    return [];
  }
};

/**
 * The org's live subscription, found WITHOUT trusting the stored customer id.
 *
 * Stripe Checkout can attach a subscription to a *different* customer than the
 * one on the org: a card-less trial converted through Checkout (see the
 * checkout route's `supersedesSubscription` path) is billed to whatever
 * customer the session resolved, and `customer_creation: "if_required"` on a
 * payment link mints a brand-new one. The org row then still points at the old,
 * now-subscription-less customer.
 *
 * That is not cosmetic: every reconcile-on-read lists subscriptions for the
 * STORED customer, finds nothing active, and writes `subscriptionStatus` back
 * to "free" — silently downgrading a paying customer moments after checkout
 * (live incident, org ifmgushjgmxhqeds on Scale, 2026-09). Searching on the
 * `organizationId` metadata every subscription we create carries is what makes
 * the lookup independent of the customer-id drift; the caller then repairs the
 * stored id.
 *
 * Resolution order: the stored customer's org-labeled subscription (one list
 * call, no search index), then the metadata search (drifted subscriptions on
 * other customers), then an unlabeled subscription on the stored customer —
 * the weakest claim, so a labeled one anywhere beats it.
 *
 * Returns the subscription plus the customer actually billing it, so callers
 * can heal `stripeCustomerId` instead of rediscovering this every read.
 */
export const findOrgLiveSubscription = async (
  stripe: Stripe,
  organizationId: string,
  storedCustomerId: string | null,
): Promise<OrgSubscriptionMatch | undefined> => {
  let unlabeledFallback: OrgSubscriptionMatch | undefined;

  // The stored customer stays the fast path: one list call, no search index.
  if (storedCustomerId) {
    const { labeled, unlabeled } = await listStoredCustomerMatches(
      stripe,
      organizationId,
      storedCustomerId,
    );
    if (labeled[0]) return labeled[0];
    unlabeledFallback = unlabeled[0];
  }

  // Nothing labeled on the stored customer. Before concluding the org
  // churned, ask Stripe for any subscription carrying this org's id. Search
  // can miss a just-created subscription — the webhook write is what covers
  // that window, and this is the backstop that keeps a stale customer id
  // from downgrading the org.
  const searched = await searchOrgSubscriptions(stripe, organizationId);
  if (searched[0]) return searched[0];

  return unlabeledFallback;
};

/**
 * Every live subscription the org holds — the stored customer's (labeled and
 * unlabeled, see {@link listStoredCustomerMatches}) plus any labeled one the
 * search finds elsewhere, deduped by id. For callers that must act on ALL of
 * them (org deletion cancels each; the churn webhook filters out the sub that
 * just died), where {@link findOrgLiveSubscription}'s single answer is not
 * enough. Search staleness applies: re-check liveness before destructive acts.
 */
export const findOrgLiveSubscriptions = async (
  stripe: Stripe,
  organizationId: string,
  storedCustomerId: string | null,
): Promise<OrgSubscriptionMatch[]> => {
  const stored = storedCustomerId
    ? await listStoredCustomerMatches(stripe, organizationId, storedCustomerId)
    : { labeled: [], unlabeled: [] };
  const searched = await searchOrgSubscriptions(stripe, organizationId);

  const out: OrgSubscriptionMatch[] = [];
  const seen = new Set<string>();
  for (const match of [...stored.labeled, ...searched, ...stored.unlabeled]) {
    if (seen.has(match.subscription.id)) continue;
    seen.add(match.subscription.id);
    out.push(match);
  }
  return out;
};

/**
 * Whether a trialing subscription has no payment method to convert with: none
 * on the subscription, no customer default (invoice settings or legacy
 * source), and nothing attached at all. Such a trial cannot be switched in
 * place: with `missing_payment_method: "cancel"` Stripe even refuses the
 * upcoming-invoice preview (`invoice_upcoming_none`), and with
 * `create_invoice` the invoice at trial end has nothing to charge. These
 * switches go through Stripe Checkout instead, which collects a card.
 */
export const trialingWithoutPaymentMethod = async (
  stripe: Stripe,
  sub: Stripe.Subscription,
): Promise<boolean> => {
  if (sub.status !== "trialing") return false;
  if (sub.default_payment_method) return false;

  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer.id;

  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) return true;
  if (customer.invoice_settings?.default_payment_method) return false;
  if (customer.default_source) return false;

  const attached = await stripe.customers.listPaymentMethods(customerId, {
    limit: 1,
  });
  return attached.data.length === 0;
};

/** The subscription item currently carrying the plan's base price, if any. */
export const findKnownBaseItem = (
  activeSub: Stripe.Subscription,
  knownBasePriceIds: readonly string[],
): Stripe.SubscriptionItem | undefined =>
  activeSub.items.data.find((i) => knownBasePriceIds.includes(i.price.id));

/**
 * Builds the subscription item changes for a plan or interval switch: swap
 * the base item to the new price and delete every other existing item — which
 * also cleans up the quantity-0 agent add-on items grandfathered
 * subscriptions still carry from the pre-2026 metered model.
 *
 * The same item list is used for the proration preview and the real update so
 * the previewed amount always matches what gets invoiced.
 *
 * The base item's quantity is CARRIED OVER, not reset to 1. A negotiated deal
 * is priced by raising the quantity on the standard plan price (e.g. Scale at
 * quantity 2 = double the seats, double the price) — that keeps the price id
 * recognizable to `resolveSubscriptionPlan`, where an unknown price would fall
 * back to "pro" and downgrade the org. Hardcoding 1 here silently halved such
 * a customer's bill the first time they touched a plan or interval switch,
 * while they kept the entitlement their override grants. Self-serve orgs are
 * unaffected: their base item is already quantity 1.
 *
 * Only a quantity ABOVE 1 is carried. A missing or zero quantity (the stale
 * metered add-ons) still normalizes to 1, so a plan switch can never produce a
 * zero-quantity, zero-charge base item.
 */
export const buildPlanSwitchItems = (
  activeSub: Stripe.Subscription,
  basePriceId: string,
  knownBasePriceIds: readonly string[],
): PlanSwitchItem[] => {
  const existingBaseItem = findKnownBaseItem(activeSub, knownBasePriceIds);

  const items: PlanSwitchItem[] = [];

  if (existingBaseItem) {
    const quantity = Math.max(existingBaseItem.quantity ?? 1, 1);
    items.push({ id: existingBaseItem.id, price: basePriceId, quantity });
  } else {
    items.push({ price: basePriceId, quantity: 1 });
  }

  for (const item of activeSub.items.data) {
    if (!items.some((i) => i.id === item.id)) {
      items.push({ id: item.id, deleted: true });
    }
  }

  return items;
};

const isProrationLine = (line: Stripe.InvoiceLineItem): boolean =>
  line.parent?.invoice_item_details?.proration === true ||
  line.parent?.subscription_item_details?.proration === true;

/**
 * Sums the proration lines of a preview invoice. With
 * `proration_behavior: "always_invoice"` these lines are exactly what gets
 * invoiced immediately on the switch — the preview's `total` also contains
 * the next cycle's base charge and must not be used for "due today".
 */
const summarizeProrationPreview = (
  invoice: Stripe.Invoice,
): { amountDueTodayCents: number; currency: string } => {
  const amountDueTodayCents = invoice.lines.data
    .filter(isProrationLine)
    .reduce((sum, line) => sum + line.amount, 0);

  return { amountDueTodayCents, currency: invoice.currency };
};

/**
 * Amount invoiced immediately for a switch. Same-interval switches invoice
 * only the proration lines (the next full charge stays at period end).
 * Interval changes restart the billing cycle (`billing_cycle_anchor: "now"`),
 * so the whole preview — proration credit plus the new period's full charge —
 * is what gets charged now.
 *
 * A customer carrying a Stripe credit balance is charged the invoice's
 * `amount_due` (below the `total` we quote); the quote is then above the
 * charge — customer-favorable and uncommon. At zero balance (the normal case,
 * and no tax is configured) `total === amount_due`, so preview == charge.
 */
export const summarizeSwitchPreview = (
  invoice: Stripe.Invoice,
  cycleRestarts: boolean,
): { amountDueTodayCents: number; currency: string } =>
  cycleRestarts
    ? { amountDueTodayCents: invoice.total, currency: invoice.currency }
    : summarizeProrationPreview(invoice);

/**
 * Renewal date after a cycle-restarting switch: the period end of the new
 * cycle's (non-proration) charge line. The pre-switch subscription's
 * `current_period_end` is wrong once the anchor moves.
 */
export const previewRenewalDate = (
  invoice: Stripe.Invoice,
): number | undefined => {
  const cycleEnds = invoice.lines.data
    .filter((line) => !isProrationLine(line))
    .map((line) => line.period?.end)
    .filter((end): end is number => typeof end === "number");

  return cycleEnds.length > 0 ? Math.max(...cycleEnds) : undefined;
};

export const hasPendingCancellation = (sub: Stripe.Subscription): boolean =>
  sub.cancel_at_period_end || sub.cancel_at !== null;

// Only echo a client-provided proration date that is recent and not in the
// future; otherwise let Stripe prorate as of now. Stripe additionally rejects
// dates outside the current billing period.
const PRORATION_DATE_MAX_AGE_SECONDS = 3600;

export const resolveProrationDate = (
  value: unknown,
  nowSec: number = Math.floor(Date.now() / 1000),
): number | undefined => {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (value > nowSec || nowSec - value > PRORATION_DATE_MAX_AGE_SECONDS) {
    return undefined;
  }
  return value;
};
