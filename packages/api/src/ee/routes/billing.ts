import { Hono } from "hono";
import Stripe from "stripe";
import { db } from "@onecli/db";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { getStripe, resolveStripeCustomer } from "../billing/stripe";
import { CAPS } from "../../lib/env";
import { appOrigin } from "../../lib/public-origins";
import { dashboardUrl } from "../../lib/dashboard-url";
import {
  PLAN_PRICE_IDS,
  SALES_MANAGED_PRICE_IDS,
  type SelfServePlan,
} from "../billing/env";
import { PRICE_TO_PLAN, KNOWN_BASE_PRICE_IDS } from "../billing/price-map";
import {
  ENTERPRISE_PLAN,
  getPlanConfig,
  isPlanOffered,
  isSalesManagedPlan,
  normalizePlan,
  type BillingInterval,
} from "../billing/plans";
import {
  buildPlanSwitchItems,
  findActivePlanSubscription,
  findKnownBaseItem,
  hasPendingCancellation,
  previewRenewalDate,
  resolveProrationDate,
  summarizeSwitchPreview,
  trialingWithoutPaymentMethod,
} from "../billing/plan-switch";
import { notifyDiscord } from "../notifications/discord";
import { logger } from "../../lib/logger";

// Self-serve switch targets only — enterprise is deliberately absent (its
// subscriptions are dashboard-managed; see price-map.ts). Object.hasOwn (not
// `in`) so prototype keys like "toString" can't pass as plans.
const isSelfServePlan = (value: string): value is SelfServePlan =>
  Object.hasOwn(PLAN_PRICE_IDS, value);

const parseInterval = (value: unknown): BillingInterval | null =>
  value === undefined || value === "month"
    ? "month"
    : value === "year"
      ? "year"
      : null;

// Sales-managed (enterprise) orgs are rejected BEFORE any Stripe call — a
// guard after a subscription mutation would leave Stripe and the org status
// out of sync.
const SALES_MANAGED_ERROR = `This organization's plan is managed by our sales team. Contact ${ENTERPRISE_PLAN.contactEmail} to make changes.`;

// Subscriptions created by sales/ops (enterprise, self-hosted Scale) must
// never be modified by self-serve switching, whatever the org's status says.
const holdsSalesManagedPrice = (sub: Stripe.Subscription): boolean =>
  sub.items.data.some((i) => SALES_MANAGED_PRICE_IDS.includes(i.price.id));

const INVALID_PLAN_ERROR = "Invalid plan. Must be 'pro', 'team' or 'scale'.";

const RETIRED_PLAN_ERROR =
  "This plan is no longer offered. Pick one of the current plans instead.";

export const billingRoutes = () => {
  const app = new Hono<ApiEnv>();

  // Billing exists only where plans do (the hosted platform). Self-host has
  // no Stripe wiring, and until the flat-team change the null role resolver
  // happened to 403 these routes there; gate the capability explicitly so a
  // self-host member gets a clean 404 instead of a Stripe constructor crash.
  app.use("*", async (c, next) => {
    if (!CAPS.billing) {
      return c.json(
        {
          error: {
            message: "Billing is not available on this deployment",
            type: "invalid_request_error",
          },
        },
        404,
      );
    }
    return next();
  });

  // POST /checkout
  app.post(
    "/checkout",
    auth({ requireWorkspace: false, role: "admin" }),
    async (c) => {
      const authCtx = c.get("auth");

      const body = (await c.req.json().catch(() => ({}))) as {
        plan?: string;
        interval?: string;
        cancelUrl?: string;
        prorationDate?: number;
      };

      if (body.plan === "free") {
        return c.json({ error: "Free plan does not require checkout." }, 400);
      }

      const interval = parseInterval(body.interval);
      if (!body.plan || !isSelfServePlan(body.plan) || interval === null) {
        return c.json({ error: INVALID_PLAN_ERROR }, 400);
      }

      const basePriceId = PLAN_PRICE_IDS[body.plan][interval];
      if (!basePriceId) {
        logger.error(
          { component: "checkout", plan: body.plan, interval },
          "missing Stripe price id for plan/interval",
        );
        return c.json({ error: "This plan is not available right now." }, 400);
      }

      const organization = await db.organization.findUniqueOrThrow({
        where: { id: authCtx.organizationId },
        select: {
          id: true,
          name: true,
          stripeCustomerId: true,
          subscriptionStatus: true,
        },
      });

      if (isSalesManagedPlan(normalizePlan(organization.subscriptionStatus))) {
        return c.json({ error: SALES_MANAGED_ERROR }, 400);
      }

      // Retired plans (pro) stay switchable for orgs already on them
      // (interval changes), but are never purchasable by anyone else.
      if (
        !isPlanOffered(
          body.plan,
          normalizePlan(organization.subscriptionStatus),
        )
      ) {
        return c.json({ error: RETIRED_PLAN_ERROR }, 400);
      }

      const subscriptionMetadata = {
        organizationId: organization.id,
        organizationName: organization.name,
        ownerUserId: authCtx.userId,
        ownerEmail: authCtx.userEmail,
      };

      try {
        const stripe = getStripe();
        const customerId = await resolveStripeCustomer(
          organization,
          authCtx.userEmail,
        );
        const baseUrl = appOrigin();

        const activeSub = await findActivePlanSubscription(
          stripe,
          customerId,
          organization.id,
        );

        let supersededTrialSub: Stripe.Subscription | undefined;

        if (activeSub) {
          if (holdsSalesManagedPrice(activeSub)) {
            return c.json({ error: SALES_MANAGED_ERROR }, 400);
          }

          const currentBaseItem = findKnownBaseItem(
            activeSub,
            KNOWN_BASE_PRICE_IDS,
          );
          if (currentBaseItem?.price.id === basePriceId) {
            return c.json(
              { error: "You're already on this plan and billing interval." },
              400,
            );
          }

          const cardlessTrial = await trialingWithoutPaymentMethod(
            stripe,
            activeSub,
          );

          if (!cardlessTrial) {
            const items = buildPlanSwitchItems(
              activeSub,
              basePriceId,
              KNOWN_BASE_PRICE_IDS,
            );

            const prorationDate = resolveProrationDate(body.prorationDate);

            // A month↔year switch restarts the billing cycle at the switch
            // (Stripe resets the anchor on interval changes; we pass it
            // explicitly so preview and update agree). Trialing subscriptions
            // keep their trial; the new interval starts billing at trial end.
            const cycleRestarts =
              activeSub.status !== "trialing" &&
              currentBaseItem?.price.recurring?.interval !== undefined &&
              currentBaseItem.price.recurring.interval !== interval;

            // always_invoice + error_if_incomplete: the proration is invoiced
            // and charged immediately, and if the charge fails Stripe leaves
            // the subscription unchanged (402). A pending cancellation is
            // cleared in the same update; switching plans means staying.
            await stripe.subscriptions.update(activeSub.id, {
              items,
              proration_behavior: "always_invoice",
              payment_behavior: "error_if_incomplete",
              ...(cycleRestarts
                ? { billing_cycle_anchor: "now" as const }
                : {}),
              ...(prorationDate !== undefined
                ? { proration_date: prorationDate }
                : {}),
              ...(activeSub.cancel_at_period_end
                ? { cancel_at_period_end: false }
                : activeSub.cancel_at !== null
                  ? { cancel_at: "" }
                  : {}),
              metadata: subscriptionMetadata,
            });

            const newStatus = PRICE_TO_PLAN[basePriceId] ?? "pro";
            await db.organization.update({
              where: { id: organization.id },
              data: { subscriptionStatus: newStatus },
            });

            notifyDiscord("payment", {
              email: authCtx.userEmail,
              organizationId: organization.id,
              organizationName: organization.name,
              plan: newStatus,
              type: "plan_switch",
              countryCode:
                c.req.header("cloudfront-viewer-country") ?? undefined,
              country:
                c.req.header("cloudfront-viewer-country-name") ?? undefined,
            });

            return c.json({ switched: true });
          }

          // A card-less trial can't be converted in place: updating it would
          // keep the trial and (with missing_payment_method=cancel) still
          // cancel at trial end without ever charging. Fall through to Stripe
          // Checkout so the customer enters a card and starts paying now; the
          // checkout.session.completed webhook then cancels this superseded
          // trial.
          supersededTrialSub = activeSub;
        }

        let cancelUrl = dashboardUrl("/billing", {
          organizationId: authCtx.organizationId,
        });
        if (body.cancelUrl) {
          try {
            const parsed = new URL(body.cancelUrl);
            const base = new URL(baseUrl);
            if (parsed.origin === base.origin) {
              cancelUrl = body.cancelUrl;
            }
          } catch {
            // ignore invalid URLs
          }
        }

        const lineItems: { price: string; quantity?: number }[] = [
          { price: basePriceId, quantity: 1 },
        ];

        const checkoutSession = await stripe.checkout.sessions.create({
          mode: "subscription",
          currency: "usd",
          customer: customerId,
          line_items: lineItems,
          allow_promotion_codes: true,
          subscription_data: {
            metadata: {
              ...subscriptionMetadata,
              ...(supersededTrialSub
                ? { supersedesSubscription: supersededTrialSub.id }
                : {}),
            },
          },
          success_url: dashboardUrl("/billing?checkout=success", {
            organizationId: authCtx.organizationId,
          }),
          cancel_url: cancelUrl,
        });

        return c.json({ checkout_url: checkoutSession.url });
      } catch (err) {
        // error_if_incomplete surfaces failed charges as card errors and
        // SCA/3DS-required cards as subscription_payment_intent_requires_action.
        if (
          err instanceof Stripe.errors.StripeCardError ||
          (err instanceof Stripe.errors.StripeError &&
            (err.statusCode === 402 ||
              err.code === "subscription_payment_intent_requires_action"))
        ) {
          logger.warn(
            { err, component: "checkout" },
            "plan switch payment failed",
          );
          return c.json(
            {
              error:
                err.message ||
                "Your card was declined. Update your payment method and try again.",
            },
            402,
          );
        }
        logger.error(
          { err, component: "checkout" },
          "checkout session creation failed",
        );
        const message = err instanceof Error ? err.message : "Unknown error";
        return c.json({ error: message }, 500);
      }
    },
  );

  // POST /checkout/preview — proration preview for a paid→paid plan switch
  app.post(
    "/checkout/preview",
    auth({ requireWorkspace: false, role: "admin" }),
    async (c) => {
      const authCtx = c.get("auth");

      const body = (await c.req.json().catch(() => ({}))) as {
        plan?: string;
        interval?: string;
      };

      const interval = parseInterval(body.interval);
      if (!body.plan || !isSelfServePlan(body.plan) || interval === null) {
        return c.json({ error: INVALID_PLAN_ERROR }, 400);
      }

      const plan = body.plan;
      const basePriceId = PLAN_PRICE_IDS[plan][interval];
      if (!basePriceId) {
        return c.json({ error: "This plan is not available right now." }, 400);
      }

      const organization = await db.organization.findUniqueOrThrow({
        where: { id: authCtx.organizationId },
        select: { id: true, stripeCustomerId: true, subscriptionStatus: true },
      });

      if (isSalesManagedPlan(normalizePlan(organization.subscriptionStatus))) {
        return c.json({ error: SALES_MANAGED_ERROR }, 400);
      }

      if (
        !isPlanOffered(plan, normalizePlan(organization.subscriptionStatus))
      ) {
        return c.json({ error: RETIRED_PLAN_ERROR }, 400);
      }

      if (!organization.stripeCustomerId) {
        return c.json({ error: "No active subscription" }, 400);
      }

      try {
        const stripe = getStripe();
        const activeSub = await findActivePlanSubscription(
          stripe,
          organization.stripeCustomerId,
          organization.id,
        );

        if (!activeSub) {
          return c.json({ error: "No active subscription" }, 400);
        }

        if (holdsSalesManagedPrice(activeSub)) {
          return c.json({ error: SALES_MANAGED_ERROR }, 400);
        }

        const currentBaseItem = findKnownBaseItem(
          activeSub,
          KNOWN_BASE_PRICE_IDS,
        );
        if (currentBaseItem?.price.id === basePriceId) {
          return c.json(
            { error: "You're already on this plan and billing interval." },
            400,
          );
        }

        const planConfig = getPlanConfig(plan);
        const newPriceCents =
          (interval === "year" ? planConfig.yearlyPrice : planConfig.price) *
          100;

        // A card-less trial has no upcoming invoice to preview (Stripe
        // rejects createPreview with invoice_upcoming_none when
        // missing_payment_method=cancel). The switch goes through Stripe
        // Checkout instead: full plan price, nothing prorated (the trial
        // has invoiced nothing).
        if (await trialingWithoutPaymentMethod(stripe, activeSub)) {
          return c.json({
            requiresCheckout: true,
            amountDueTodayCents: newPriceCents,
            currency: "usd",
            newPriceCents,
            interval,
            renewsAt: null,
            prorationDate: Math.floor(Date.now() / 1000),
            pendingCancellationCleared: false,
            trialing: true,
          });
        }

        const items = buildPlanSwitchItems(
          activeSub,
          basePriceId,
          KNOWN_BASE_PRICE_IDS,
        );

        const prorationDate = Math.floor(Date.now() / 1000);

        // Mirrors the checkout update exactly (same items, same anchor
        // behavior) so the previewed amount always matches the charge.
        const cycleRestarts =
          activeSub.status !== "trialing" &&
          currentBaseItem?.price.recurring?.interval !== undefined &&
          currentBaseItem.price.recurring.interval !== interval;

        const preview = await stripe.invoices.createPreview({
          customer: organization.stripeCustomerId,
          subscription: activeSub.id,
          subscription_details: {
            items,
            proration_date: prorationDate,
            ...(cycleRestarts ? { billing_cycle_anchor: "now" as const } : {}),
          },
        });

        const { amountDueTodayCents, currency } = summarizeSwitchPreview(
          preview,
          cycleRestarts,
        );
        const periodEnd = cycleRestarts
          ? (previewRenewalDate(preview) ??
            activeSub.items.data[0]?.current_period_end)
          : activeSub.items.data[0]?.current_period_end;

        return c.json({
          requiresCheckout: false,
          amountDueTodayCents,
          currency,
          newPriceCents,
          interval,
          renewsAt: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
          prorationDate,
          pendingCancellationCleared: hasPendingCancellation(activeSub),
          trialing: activeSub.status === "trialing",
        });
      } catch (err) {
        logger.error(
          { err, component: "checkout-preview" },
          "proration preview failed",
        );
        const message = err instanceof Error ? err.message : "Unknown error";
        return c.json({ error: message }, 500);
      }
    },
  );

  // POST /portal
  app.post(
    "/portal",
    auth({ requireWorkspace: false, role: "admin" }),
    async (c) => {
      const authCtx = c.get("auth");

      const organization = await db.organization.findUniqueOrThrow({
        where: { id: authCtx.organizationId },
        select: { id: true, stripeCustomerId: true },
      });

      try {
        const customerId = await resolveStripeCustomer(
          organization,
          authCtx.userEmail,
        );

        const portalSession = await getStripe().billingPortal.sessions.create({
          customer: customerId,
          return_url: dashboardUrl("/billing", {
            organizationId: organization.id,
          }),
        });

        return c.json({ portal_url: portalSession.url });
      } catch (err) {
        logger.error(
          { err, component: "billing-portal" },
          "portal session creation failed",
        );
        const message = err instanceof Error ? err.message : "Unknown error";
        return c.json({ error: message }, 500);
      }
    },
  );

  // POST /reactivate
  app.post(
    "/reactivate",
    auth({ requireWorkspace: false, role: "admin" }),
    async (c) => {
      const authCtx = c.get("auth");

      const organization = await db.organization.findUniqueOrThrow({
        where: { id: authCtx.organizationId },
        select: { stripeCustomerId: true, subscriptionStatus: true },
      });

      if (isSalesManagedPlan(normalizePlan(organization.subscriptionStatus))) {
        return c.json({ error: SALES_MANAGED_ERROR }, 400);
      }

      if (!organization.stripeCustomerId) {
        return c.json({ error: "No subscription" }, 400);
      }

      try {
        const stripe = getStripe();
        const subscriptions = await stripe.subscriptions.list({
          customer: organization.stripeCustomerId,
          limit: 1,
        });

        const sub = subscriptions.data.find(
          (s) =>
            (s.status === "active" || s.status === "trialing") &&
            (s.cancel_at_period_end || s.cancel_at !== null),
        );

        if (!sub) {
          return c.json({ error: "No canceling subscription found" }, 400);
        }

        if (sub.cancel_at_period_end) {
          await stripe.subscriptions.update(sub.id, {
            cancel_at_period_end: false,
          });
        } else {
          await stripe.subscriptions.update(sub.id, {
            cancel_at: "" as unknown as number,
          });
        }

        return c.json({ reactivated: true });
      } catch (err) {
        logger.error(
          { err, component: "reactivate" },
          "subscription reactivation failed",
        );
        const message = err instanceof Error ? err.message : "Unknown error";
        return c.json({ error: message }, 500);
      }
    },
  );

  return app;
};
