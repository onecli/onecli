"use server";

import { db } from "@onecli/db";
import { getStripe } from "@onecli/api/ee/billing/stripe";
import {
  findOrgPaymentIssue,
  type PaymentIssue,
} from "@onecli/api/ee/billing/payment-issue";
import { requireOrgAdminContext } from "@/lib/actions/resolve-user";
import { CAPS } from "@/lib/env";

export type OrgPaymentIssue = PaymentIssue & { organizationId: string };

/**
 * The org's current payment problem (failed renewal or dunning cancel), for the
 * dashboard banner. Admin-only: members can't fix billing, and the result
 * carries the open invoice's hosted pay link. Returns null (never throws) for
 * non-admins and on any Stripe error, because the banner renders on every page
 * and must never break it. `organizationId` lets the banner build the billing
 * link on workspace pages, whose URL carries no org id.
 */
export async function getPaymentIssue(): Promise<OrgPaymentIssue | null> {
  if (!CAPS.billing) return null;

  try {
    const { organizationId } = await requireOrgAdminContext();

    const org = await db.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { stripeCustomerId: true },
    });
    // Stripe-billed orgs only: no Stripe customer, nothing that could fail.
    if (!org.stripeCustomerId) return null;

    const issue = await findOrgPaymentIssue(
      getStripe(),
      organizationId,
      org.stripeCustomerId,
    );
    return issue ? { ...issue, organizationId } : null;
  } catch {
    return null;
  }
}
