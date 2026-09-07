"use server";

import { db } from "@onecli/db";
import { getStripe } from "@onecli/api/ee/billing/stripe";
import { resolveOrgContext } from "@/lib/actions/resolve-user";
import type { ResolveOptions } from "@/lib/actions/resolve-user";
import { resolveSubscriptionPlan } from "@onecli/api/ee/billing/subscription-plan";
import { findOrgLiveSubscription } from "@onecli/api/ee/billing/plan-switch";
import { SALES_MANAGED_PRICE_IDS } from "@onecli/api/ee/billing/env";
import type {
  BillingInterval,
  SubscriptionStatus,
} from "@onecli/api/ee/billing/plans";

export interface SubscriptionState {
  status: SubscriptionStatus;
  hasStripeCustomer: boolean;
  cancelAtPeriodEnd: boolean;
  /** Billing interval of the active subscription's base price; null = none. */
  interval: BillingInterval | null;
  /** Current period end (ISO); the renewal — or, when canceling, end — date. */
  renewsAt: string | null;
  /** Subscription is sales/ops-managed (enterprise, self-hosted Scale). */
  salesManaged: boolean;
}

export async function getSubscriptionStatus(
  options?: ResolveOptions,
): Promise<SubscriptionState> {
  const { organizationId } = await resolveOrgContext(options);

  const organization = await db.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { id: true, stripeCustomerId: true, subscriptionStatus: true },
  });

  let status = organization.subscriptionStatus as SubscriptionStatus;

  // AWS-Marketplace-billed orgs: status is owned by the marketplace
  // fulfillment/SNS flows, never by Stripe reconciliation. Report it as
  // sales-managed so the UI hides every self-serve billing control.
  if (status === "aws-marketplace") {
    return {
      status,
      hasStripeCustomer: !!organization.stripeCustomerId,
      cancelAtPeriodEnd: false,
      interval: "year",
      renewsAt: null,
      salesManaged: true,
    };
  }

  if (organization.stripeCustomerId) {
    try {
      // Looks up by org metadata, not just the stored customer: Checkout can
      // bill a converted trial to a different customer, and listing only the
      // stored one then reads as "no subscription" and downgrades a paying
      // org to free on the next page load. See findOrgLiveSubscription.
      const found = await findOrgLiveSubscription(
        getStripe(),
        organization.id,
        organization.stripeCustomerId,
      );

      if (found) {
        const activeSub = found.subscription;

        // Heal the drifted pointer so every other Stripe read (usage, portal,
        // plan switch) converges on the customer actually being billed.
        //
        // Isolated from the plan write: `stripeCustomerId` is @unique, so if
        // another org already claims this customer the update throws. That
        // must not abort the reconcile — the plan we just resolved is correct
        // and is the whole point of this call. Heal opportunistically, report
        // the plan regardless.
        if (found.customerId !== organization.stripeCustomerId) {
          try {
            await db.organization.update({
              where: { id: organization.id },
              data: { stripeCustomerId: found.customerId },
            });
          } catch {
            // Another org holds this customer id (shared-customer edge, ops
            // cleanup mid-flight). Leave the pointer; the metadata lookup
            // above does not depend on it.
          }
        }

        const { plan, baseItem } = resolveSubscriptionPlan(activeSub);
        status = plan;

        if (status !== organization.subscriptionStatus) {
          await db.organization.update({
            where: { id: organization.id },
            data: { subscriptionStatus: status },
          });
        }

        const subItem = baseItem ?? activeSub.items.data[0];
        const rawInterval = subItem?.price.recurring?.interval;

        const canceling =
          activeSub.cancel_at_period_end || activeSub.cancel_at !== null;
        return {
          status,
          hasStripeCustomer: true,
          cancelAtPeriodEnd: canceling,
          interval:
            rawInterval === "month" || rawInterval === "year"
              ? rawInterval
              : null,
          renewsAt: subItem?.current_period_end
            ? new Date(subItem.current_period_end * 1000).toISOString()
            : null,
          salesManaged:
            status === "enterprise" ||
            activeSub.items.data.some((item) =>
              SALES_MANAGED_PRICE_IDS.includes(item.price.id),
            ),
        };
      }

      status = "free";
      if (status !== organization.subscriptionStatus) {
        await db.organization.update({
          where: { id: organization.id },
          data: { subscriptionStatus: status },
        });
      }
    } catch {
      // Fall through with stored status
    }
  }

  return {
    status,
    hasStripeCustomer: !!organization.stripeCustomerId,
    cancelAtPeriodEnd: false,
    interval: null,
    renewsAt: null,
    salesManaged: status === "enterprise",
  };
}
