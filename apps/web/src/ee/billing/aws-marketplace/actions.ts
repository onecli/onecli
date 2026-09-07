"use server";

// Server actions for the AWS Marketplace registration page
// (plans/aws-marketplace-listing.md §3). The token was parked in the
// httpOnly cookie by /aws-marketplace/fulfill; completing registration
// consumes it against the caller's org.
//
// HOSTED ONLY: server actions compile to POST endpoints reachable by any
// signed-in user regardless of which pages render, so each action carries
// its own edition gate (defense in depth beside the page/route gates) —
// mirroring the /v1 intake's cloudOnly law.

import { cookies } from "next/headers";
import { resolveOrgContextWithRole } from "@/lib/actions/resolve-user";
import {
  registerMarketplaceCustomer,
  AwsMarketplaceError,
} from "@onecli/api/ee/billing/aws-marketplace/service";
import { IS_CLOUD } from "@/lib/env";
import { AWS_MP_TOKEN_COOKIE } from "./token-cookie";

export interface RegistrationResult {
  ok: boolean;
  error?: string;
  /** "subscribed" once a license is active; "pending" while AWS confirms. */
  status?: string;
  entitledAgents?: number;
  contractExpiresAt?: string | null;
}

/** Whether a parked marketplace token is present (page render decision). */
export async function hasPendingMarketplaceToken(): Promise<boolean> {
  if (!IS_CLOUD) return false;
  const store = await cookies();
  return !!store.get(AWS_MP_TOKEN_COOKIE)?.value;
}

export async function completeMarketplaceRegistration(): Promise<RegistrationResult> {
  if (!IS_CLOUD) {
    return { ok: false, error: "Not available on this deployment." };
  }
  const store = await cookies();
  const token = store.get(AWS_MP_TOKEN_COOKIE)?.value;
  if (!token) {
    return {
      ok: false,
      error:
        "No AWS Marketplace registration in progress (the link may have expired). Return to AWS Marketplace and click 'Set up your account' again.",
    };
  }

  let ctx;
  try {
    ctx = await resolveOrgContextWithRole();
  } catch {
    return { ok: false, error: "Sign in to continue." };
  }
  if (ctx.role !== "admin" && ctx.role !== "owner") {
    return {
      ok: false,
      error:
        "Only organization admins can link an AWS Marketplace subscription.",
    };
  }

  try {
    const subscription = await registerMarketplaceCustomer({
      organizationId: ctx.organizationId,
      registrationToken: token,
      registrantEmail: ctx.userEmail,
    });
    store.delete(AWS_MP_TOKEN_COOKIE);
    return {
      ok: true,
      status: subscription.status,
      entitledAgents: subscription.entitledAgents,
      contractExpiresAt: subscription.contractExpiresAt?.toISOString() ?? null,
    };
  } catch (err) {
    if (err instanceof AwsMarketplaceError) {
      if (err.code === "INVALID_TOKEN") store.delete(AWS_MP_TOKEN_COOKIE);
      return { ok: false, error: err.message };
    }
    return { ok: false, error: "Registration failed. Try again." };
  }
}
