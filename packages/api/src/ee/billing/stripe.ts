import Stripe from "stripe";
import { db } from "@onecli/db";
import { STRIPE_SECRET_KEY } from "../../lib/env";

let _stripe: Stripe | null = null;

export function getStripe() {
  if (!_stripe) {
    _stripe = new Stripe(STRIPE_SECRET_KEY!);
  }
  return _stripe;
}

/**
 * Resolves a valid Stripe customer ID for an organization.
 * If the stored customer ID doesn't exist in the current Stripe account
 * (e.g. dev vs prod mismatch), it creates a new customer and updates the DB.
 */
export async function resolveStripeCustomer(
  organization: {
    id: string;
    stripeCustomerId: string | null;
  },
  email: string,
): Promise<string> {
  const stripe = getStripe();

  if (organization.stripeCustomerId) {
    try {
      await stripe.customers.retrieve(organization.stripeCustomerId);
      return organization.stripeCustomerId;
    } catch (err) {
      if (
        err instanceof Stripe.errors.StripeInvalidRequestError &&
        err.message.includes("No such customer")
      ) {
        // Fall through to create a new customer
      } else {
        throw err;
      }
    }
  }

  const customer = await stripe.customers.create({
    email,
    metadata: { organizationId: organization.id },
  });

  await db.organization.update({
    where: { id: organization.id },
    data: { stripeCustomerId: customer.id },
  });

  return customer.id;
}
