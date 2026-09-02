import { db } from "@onecli/db";
import { activeMembershipWhere } from "../../services/organization-service";
import { notifyDiscord } from "../notifications/discord";
import { sendWelcomeEmail } from "../notifications/welcome-email";
import { ensureSsoJitMembership } from "../sso/jit-service";
import { resolveIdentityConflict } from "../../lib/identity-conflict";
import type { SessionHooks } from "../../routes/auth-session";

export const eeSessionHooks: SessionHooks = {
  // Nothing to reconcile: cloud identities come from Cognito, which never had
  // the self-hosted no-login mode to upgrade away from. Stated rather than
  // inherited so the opt-out is visible here.
  beforeIdentitySync: async () => {},

  resolveIdentityConflict,

  ensureSessionMembership: ensureSsoJitMembership,

  getSessionAttributes: (request) => {
    const countryCode =
      request.headers.get("cloudfront-viewer-country") ?? undefined;
    const country =
      request.headers.get("cloudfront-viewer-country-name") ?? undefined;
    return {
      ...(countryCode && { countryCode }),
      ...(country && { country }),
    };
  },

  onUserCreated: (user, attrs, context) => {
    // Signup ping + welcome email for organic signups (the ones that
    // bootstrapped their own organization) and provision claims. A claimer
    // joins an existing org — no bootstrap — but they ARE a new signup worth
    // announcing, labeled by the `fromClaim` marker the claim flow puts on
    // the session sync. Someone joining through a plain invitation (or SSO
    // JIT) stays silent.
    const fromClaim = new URL(context.request.url).searchParams.get(
      "fromClaim",
    );
    if (!context.bootstrappedOrg && !fromClaim) return;
    notifyDiscord("user_signup", {
      email: user.email,
      name: user.name,
      countryCode: attrs.countryCode as string | undefined,
      country: attrs.country as string | undefined,
      source: fromClaim ? "provision claim" : undefined,
    });
    sendWelcomeEmail(user.email, user.name);
  },

  // Cloud is unchanged: still only a user this request created, and still
  // never for someone arriving through an invitation (they join an existing
  // organization). Cognito creates no rows of its own, so there is nothing
  // here to repair later.
  shouldBootstrapOrg: (request, { isNewUser }) =>
    isNewUser && !new URL(request.url).searchParams.get("fromInvitation"),

  augmentSessionResponse: async (userId) => {
    // Suspended-only users read as org-less → onboarding, not a dead org.
    const hasOrg = await db.organizationMember.findFirst({
      where: { userId, ...activeMembershipWhere },
      select: { organizationId: true },
    });
    return { hasOrg: !!hasOrg };
  },
};
