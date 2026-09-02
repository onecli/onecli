"use server";

import { db } from "@onecli/db";
import { CAPS } from "@/lib/env";
import { resolveOrgContextWithRole } from "@/lib/actions/resolve-user";
import { normalizePlan } from "@onecli/api/ee/billing/plans";

/** Check if the user needs a redirect before seeing the dashboard.
 * Billing editions only — without billing there is no subscription-driven
 * onboarding gate, so no redirect. */
export const checkDashboardRedirect = async (): Promise<string | null> => {
  if (!CAPS.billing) return null;

  let organizationId: string;
  let userId: string;
  let role: string;
  try {
    ({ organizationId, userId, role } = await resolveOrgContextWithRole());
  } catch {
    return null;
  }

  // Onboarding is the org creator's install walkthrough — only the org's
  // OWNER is ever routed into it. Invited and directory-provisioned members
  // (admin/member; owner is never assignable) join a working org and must
  // not be bounced into a flow that assumes they are setting it up.
  if (role !== "owner") return null;

  const [user, org] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: { onboardingCompletedAt: true },
    }),
    db.organization.findUnique({
      where: { id: organizationId },
      select: { subscriptionStatus: true },
    }),
  ]);

  if (!user || !org) return null;

  if (org.subscriptionStatus !== "free") return null;

  return user.onboardingCompletedAt ? null : "/onboarding";
};

/** Resolve the current subscription plan; null where billing is off. */
export const getCurrentPlan = async (): Promise<string | null> => {
  if (!CAPS.billing) return null;
  try {
    // Imported after the capability early-return so the billing actions
    // (and the Stripe graph behind them) never load in non-billing server
    // processes.
    const { getSubscriptionStatus } = await import("@/ee/billing/actions");
    const { status } = await getSubscriptionStatus();
    return normalizePlan(status);
  } catch {
    return null;
  }
};
