"use server";

import { db } from "@onecli/db";
import { CAPS } from "@/lib/env";
import { resolveOrgContextWithRole } from "@/lib/actions/resolve-user";
import { normalizePlan } from "@onecli/api/ee/billing/plans";

/** Check if the user needs a redirect before seeing the dashboard.
 *
 * Onboarding (welcome → create your first agent) runs on EVERY edition: a
 * fresh org owner is routed into it until they finish or skip it. Billing
 * only adds an exemption — a paid org's owner already has what they came
 * for, so they are left alone — and that subscription read is the one thing
 * that must never run without billing (it reaches the Stripe graph). */
export const checkDashboardRedirect = async (): Promise<string | null> => {
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

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { onboardingCompletedAt: true },
  });
  if (!user) return null;

  if (CAPS.billing) {
    const org = await db.organization.findUnique({
      where: { id: organizationId },
      select: { subscriptionStatus: true },
    });
    if (!org || org.subscriptionStatus !== "free") return null;
  }

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
