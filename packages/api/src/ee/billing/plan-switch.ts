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
