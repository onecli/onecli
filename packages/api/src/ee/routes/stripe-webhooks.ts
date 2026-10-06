import { Hono } from "hono";
import Stripe from "stripe";
import { db } from "@onecli/db";
import { getStripe } from "../billing/stripe";
import { STRIPE_WEBHOOK_SECRET } from "../billing/env";
import { normalizePlan, type Plan } from "../billing/plans";
import {
  findActivePlanSubscription,
  findOrgLiveSubscriptions,
  stripeRefId,
} from "../billing/plan-switch";
import { resolveSubscriptionPlan } from "../billing/subscription-plan";
import { cloudOnly } from "../middleware/cloud-only";
import { notifyDiscord } from "../notifications/discord";
import { logger } from "../../lib/logger";

// Stripe is the source of truth for subscriptionStatus: webhook writes are
// unconditional (updateMany tolerates a deleted org). Enterprise arrives via
// the shared plan map like any plan, and enterprise churn correctly downgrades.
// The one exception is AWS-Marketplace-billed orgs: their status is owned by
// the marketplace fulfillment/SNS flows, so a stray Stripe event (e.g. a
// leftover customer object) must never overwrite it.
const applySubscriptionStatus = (organizationId: string, status: string) =>
  db.organization.updateMany({
    where: {
      id: organizationId,
      subscriptionStatus: { not: "aws-marketplace" },
    },
    data: { subscriptionStatus: status },
  });

/**
 * Repoints the org at the customer billing `subscription`.
 *
 * `Organization.stripeCustomerId` is the key every later Stripe read uses, and
 * Checkout does not guarantee it matches the customer we stored. Healing it
 * here, at the one moment Stripe tells us which customer won, is what keeps
 * the reconcile-on-read paths from later finding an empty customer and
 * downgrading a paying org to free.
 *
 * Best-effort: the plan status is already written, and the webhook must ack.
 */
const adoptSubscriptionCustomer = async (
  organizationId: string,
  subscription: Stripe.Subscription,
) => {
  const customerId = stripeRefId(subscription.customer);
  if (!customerId) return;

  try {
    // Prisma's NOT-equals excludes NULL rows (SQL three-valued logic), and an
    // org that first pays through a payment link has stripeCustomerId NULL —
    // the exact row this adoption exists for. Spell out both cases.
    await db.organization.updateMany({
      where: {
        id: organizationId,
        OR: [
          { stripeCustomerId: null },
          { NOT: { stripeCustomerId: customerId } },
        ],
      },
      data: { stripeCustomerId: customerId },
    });
  } catch (err) {
    logger.error(
      { err, organizationId, customerId },
      "failed to adopt subscription customer id",
    );
  }
};

export const stripeWebhookRoutes = () => {
  const app = new Hono();

  // Hosted-platform plumbing like the Resend intake: only OUR Stripe account
  // posts here, so the surface is edition-dark off cloud. The signature and
  // config checks below still decide within cloud.
  app.use("*", cloudOnly);

  app.post("/", async (c) => {
    if (!STRIPE_WEBHOOK_SECRET) {
      logger.warn("STRIPE_WEBHOOK_SECRET not configured, rejecting webhook");
      return c.json({ error: "Webhook not configured" }, 500);
    }

    const signature = c.req.header("stripe-signature");
    if (!signature) {
      return c.json({ error: "Missing signature" }, 400);
    }

    const body = await c.req.text();

    let event: Stripe.Event;
    try {
      event = getStripe().webhooks.constructEvent(
        body,
        signature,
        STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      logger.warn({ err }, "stripe webhook signature verification failed");
      return c.json({ error: "Invalid signature" }, 400);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      if (session.mode === "subscription" && session.subscription) {
        const stripe = getStripe();
        const subscription = await stripe.subscriptions.retrieve(
          session.subscription as string,
        );

        const organizationId = subscription.metadata.organizationId;
        const email =
          subscription.metadata.ownerEmail ?? session.customer_email ?? "";
        const organizationName = subscription.metadata.organizationName ?? null;

        const { plan } = resolveSubscriptionPlan(subscription);

        if (organizationId) {
          await applySubscriptionStatus(organizationId, plan);

          // Point the org at the customer that actually holds the paid
          // subscription. Checkout can bill a different customer than the one
          // stored (a converted card-less trial, or a payment link with
          // customer_creation: "if_required" minting a fresh one). Leaving the
          // stale id behind means every later Stripe read lists an empty
          // customer and reconciles the paying org back down to free.
          await adoptSubscriptionCustomer(organizationId, subscription);

          // A card-less trial the customer just converted away from (see the
          // checkout route): cancel it now that the paid subscription exists.
          const supersededId = subscription.metadata.supersedesSubscription;
          if (supersededId && supersededId !== subscription.id) {
            await cancelSupersededSubscription(
              stripe,
              supersededId,
              subscription.id,
              organizationId,
            );
          }
        }

        const countryCode =
          session.customer_details?.address?.country ?? undefined;

        notifyDiscord("payment", {
          email,
          organizationId,
          organizationName,
          plan,
          type: "new_subscription",
          countryCode,
        });
      }
    }

    if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object as Stripe.Subscription;
      const previousAttributes = (
        event.data as { previous_attributes?: Partial<Stripe.Subscription> }
      ).previous_attributes;
      const organizationId = subscription.metadata.organizationId ?? null;
      const stripe = getStripe();

      // Apply plan changes (upgrade, downgrade, customer-portal edits) to the
      // org as soon as Stripe reports them, instead of waiting for the next
      // billing-page load to lazily reconcile. Stripe is the source of truth.
      // Webhooks aren't delivered in order (https://docs.stripe.com/webhooks),
      // so reconcile against the *freshly retrieved* subscription and only
      // while it's live — a stale "updated" arriving after a cancellation must
      // not re-provision a dead sub. Terminal churn (dunning cancel, manual
      // cancel) flows through customer.subscription.deleted below → free.
      if (organizationId) {
        try {
          const fresh = await stripe.subscriptions.retrieve(subscription.id);
          if (fresh.status === "active" || fresh.status === "trialing") {
            const { plan } = resolveSubscriptionPlan(fresh);
            await applySubscriptionStatus(organizationId, plan);
          }
        } catch (err) {
          logger.error(
            { err, subscriptionId: subscription.id },
            "failed to reconcile plan on customer.subscription.updated",
          );
        }
      }

      if (
        subscription.cancel_at_period_end &&
        previousAttributes?.cancel_at_period_end === false
      ) {
        const email = subscription.metadata.ownerEmail ?? "";
        const organizationName = subscription.metadata.organizationName ?? null;
        const { plan } = resolveSubscriptionPlan(subscription);
        const customer = await stripe.customers.retrieve(
          subscription.customer as string,
        );
        const countryCode = !customer.deleted
          ? (customer.address?.country ?? undefined)
          : undefined;

        notifyDiscord("subscription_cancellation_scheduled", {
          email,
          organizationId,
          organizationName,
          plan,
          startedAt: subscription.start_date,
          churnsAt: subscription.cancel_at!,
          countryCode,
        });
      }
    }

    // A deletion carrying `supersededBy` is a trial the customer converted
    // away from via Checkout (see cancelSupersededSubscription): the completed
    // handler already applied the paid plan, so this is neither a downgrade
    // nor churn.
    if (
      event.type === "customer.subscription.deleted" &&
      !(event.data.object as Stripe.Subscription).metadata.supersededBy
    ) {
      const stripe = getStripe();
      const subscription = event.data.object as Stripe.Subscription;
      const organizationId = subscription.metadata.organizationId ?? null;
      const { plan } = resolveSubscriptionPlan(subscription);
      const customer = await stripe.customers.retrieve(
        subscription.customer as string,
      );
      const customerEmail = !customer.deleted ? (customer.email ?? "") : "";
      const email = subscription.metadata.ownerEmail || customerEmail;
      const organizationName = subscription.metadata.organizationName ?? null;
      const countryCode = !customer.deleted
        ? (customer.address?.country ?? undefined)
        : undefined;

      const everPaid =
        subscription.status !== "trialing" ||
        (subscription.latest_invoice != null &&
          typeof subscription.latest_invoice === "object" &&
          subscription.latest_invoice.amount_paid > 0);

      // The org may still hold another live subscription (a superseded trial
      // whose marker didn't stick, an ops duplicate cleanup): converge on its
      // plan instead of downgrading a still-subscribed org to free.
      let remainingPlan: Plan | null = null;
      if (organizationId) {
        try {
          // Searched by org metadata, not just this subscription's customer:
          // after a Checkout conversion the org's live subscription can sit on
          // a DIFFERENT customer, and looking only at this one would report
          // "nothing left" and downgrade a still-paying org to free.
          //
          // Scoped to the org's OWN stored customer, not the dead sub's: the
          // lookup's metadata-less fallback is only legitimate on the customer
          // the org row uniquely claims, and the dead sub's customer can be a
          // shared one whose unlabeled (dashboard-created) subscription
          // belongs to another org.
          //
          // The sub that just died is excluded by id: Stripe's search index is
          // eventually consistent and can still return it as "active" for a
          // while after the deletion — without the filter, a churned org keeps
          // its paid plan until the next reconcile-on-read.
          const orgRow = await db.organization.findUnique({
            where: { id: organizationId },
            select: { stripeCustomerId: true },
          });
          const storedCustomerId = orgRow?.stripeCustomerId ?? null;
          let remaining = (
            await findOrgLiveSubscriptions(
              stripe,
              organizationId,
              storedCustomerId,
            )
          ).find((m) => m.subscription.id !== subscription.id);

          // Mid-drift the dead sub's customer can differ from the stored one,
          // and when search is unavailable the lookup above cannot see it. A
          // metadata-fenced subscription there still counts — only the
          // unlabeled fallback stays reserved for the org-claimed customer.
          const eventCustomerId = stripeRefId(subscription.customer);
          if (!remaining && eventCustomerId) {
            const labeled = await findActivePlanSubscription(
              stripe,
              eventCustomerId,
              organizationId,
            );
            if (labeled && labeled.id !== subscription.id) {
              remaining = {
                subscription: labeled,
                customerId: eventCustomerId,
              };
            }
          }
          if (remaining) {
            remainingPlan = resolveSubscriptionPlan(
              remaining.subscription,
            ).plan;
            await adoptSubscriptionCustomer(
              organizationId,
              remaining.subscription,
            );
          }
        } catch (err) {
          logger.error(
            { err, subscriptionId: subscription.id },
            "failed to check for remaining subscriptions on deletion",
          );
        }
        await applySubscriptionStatus(organizationId, remainingPlan ?? "free");
      }

      if (remainingPlan === null) {
        notifyDiscord("subscription_churned", {
          email,
          organizationId,
          organizationName,
          plan,
          countryCode,
          everPaid,
        });
      }
    }

    if (event.type === "invoice.paid") {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId = stripeRefId(
        invoice.parent?.subscription_details?.subscription,
      );

      if (subscriptionId) {
        const stripe = getStripe();
        // One retrieve serves both steps: the adoption reads the sub's
        // customer and default payment method, the notification its metadata.
        // Both are best-effort, so a Stripe failure is logged and the webhook
        // still acks.
        try {
          const subscription =
            await stripe.subscriptions.retrieve(subscriptionId);

          await adoptPayingPaymentMethod(stripe, invoice, subscription);

          if (invoice.billing_reason === "subscription_cycle") {
            await notifyPaymentCollected(invoice, subscription);
          }
        } catch (err) {
          logger.error(
            { err, invoiceId: invoice.id, subscriptionId },
            "failed to process paid subscription invoice",
          );
        }
      }
    }

    return c.json({ received: true });
  });

  return app;
};

/**
 * Cancels the card-less trial a customer converted away from via Checkout.
 * `supersededBy` is written BEFORE the cancel so the resulting
 * customer.subscription.deleted event (webhooks are unordered) always
 * carries the conversion marker and is never treated as churn. The
 * organizationId metadata stays intact for audit; the deleted handler's
 * remaining-subscription check is the structural backstop if this helper
 * fails entirely (the trial then cancels at trial end without downgrading
 * the org). Errors are logged, never thrown: the paid subscription is live
 * and the webhook must ack.
 */
async function cancelSupersededSubscription(
  stripe: Stripe,
  oldSubscriptionId: string,
  newSubscriptionId: string,
  organizationId: string,
) {
  try {
    const oldSub = await stripe.subscriptions.retrieve(oldSubscriptionId);
    // Re-delivered webhook or already-terminal sub: nothing to cancel.
    if (oldSub.status !== "trialing" && oldSub.status !== "active") return;
    if (oldSub.metadata.organizationId !== organizationId) return;

    await stripe.subscriptions.update(oldSubscriptionId, {
      metadata: { supersededBy: newSubscriptionId },
    });
    await stripe.subscriptions.cancel(oldSubscriptionId);
  } catch (err) {
    logger.error(
      { err, oldSubscriptionId, newSubscriptionId },
      "failed to cancel superseded trial subscription",
    );
  }
}

/**
 * Makes the payment method that just paid a subscription invoice the
 * subscription's default, so the next renewal charges it too.
 *
 * A subscription-level `default_payment_method` beats the customer default,
 * and paying a past-due invoice with a new card (hosted invoice page, portal,
 * dashboard) does not always move it. Live incident, 2026-09: a Pro customer
 * whose Link wallet was closed paid August with a new card, which became the
 * CUSTOMER default only; September's renewal and all 7 dunning retries went
 * to the dead Link method and the org fell to free.
 *
 * Stripe's own switch for this, `payment_settings.save_default_payment_method:
 * "on_subscription"`, is not used: Checkout's `subscription_data` cannot set
 * it at creation, and every existing subscription would need a backfill
 * update. This webhook covers new and existing subscriptions alike.
 *
 * Only adopts a method attached to the subscription's own customer (anything
 * else would fail the update and is not ours to pin). Best-effort: logged,
 * never thrown, so a failure here never skips the payment notification.
 */
async function adoptPayingPaymentMethod(
  stripe: Stripe,
  invoice: Stripe.Invoice,
  subscription: Stripe.Subscription,
) {
  if (!invoice.id || invoice.amount_paid <= 0) return;
  try {
    const payments = await stripe.invoicePayments.list({
      invoice: invoice.id,
      status: "paid",
      limit: 10,
    });
    const intentId = stripeRefId(
      payments.data.find((p) => p.payment.type === "payment_intent")?.payment
        .payment_intent,
    );
    if (!intentId) return;

    const intent = await stripe.paymentIntents.retrieve(intentId, {
      expand: ["payment_method"],
    });
    const pm = intent.payment_method;
    if (!pm || typeof pm === "string") return;

    const subCustomer = stripeRefId(subscription.customer);
    if (!subCustomer || stripeRefId(pm.customer) !== subCustomer) return;

    // Only a subscription-level default can shadow the customer default. With
    // none, renewals already follow the customer default (which paying via
    // the hosted invoice page updates), and pinning one here would freeze the
    // sub on this card through later customer-level card changes.
    const current = stripeRefId(subscription.default_payment_method);
    if (!current || current === pm.id) return;

    await stripe.subscriptions.update(subscription.id, {
      default_payment_method: pm.id,
    });
  } catch (err) {
    logger.error(
      { err, invoiceId: invoice.id, subscriptionId: subscription.id },
      "failed to adopt paying payment method as subscription default",
    );
  }
}

async function notifyPaymentCollected(
  invoice: Stripe.Invoice,
  subscription: Stripe.Subscription,
) {
  const organizationId = subscription.metadata.organizationId;
  if (!organizationId) return;

  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: {
      name: true,
      subscriptionStatus: true,
      members: {
        where: { role: "admin" },
        take: 1,
        select: { user: { select: { countryCode: true, country: true } } },
      },
    },
  });
  if (!org) return;

  const plan = normalizePlan(org.subscriptionStatus ?? "free");

  const amountPaid =
    invoice.amount_paid != null
      ? (invoice.amount_paid / 100).toFixed(2)
      : "0.00";

  const owner = org.members[0]?.user;

  notifyDiscord("payment_collected", {
    organizationName: org.name ?? organizationId,
    plan,
    amountPaid,
    invoiceUrl: invoice.hosted_invoice_url ?? null,
    countryCode: owner?.countryCode ?? undefined,
    country: owner?.country ?? undefined,
  });
}
