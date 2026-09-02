import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_STATUS,
  recordAuditEvent,
} from "../services/audit-service";
import type { ExistingIdentity } from "../routes/auth-session";
import type { SessionUser } from "../providers/types";
import { findSsoOrgForIdentity } from "../ee/sso/sso-trust";

// Re-exported for consumers outside the package, which import this module via
// the exported "@onecli/api/lib/*" path.
export { IDENTITY_CONFLICT_ERROR } from "../routes/auth-session";

/**
 * Cloud identity-linking policy: a session may re-point an existing user's
 * `externalAuthId` only when it PROVED ownership of the email —
 *   1. a verified email claim (native email-OTP),
 *   2. a Google-federated session (Google is itself the email verifier; the
 *      pool's Google IdP didn't always map `email_verified`, and existing
 *      federated profiles only pick the attribute up at their next
 *      INTERACTIVE sign-in, so Google sessions can carry a false claim
 *      indefinitely), or
 *   3. an enterprise-SSO session whose provider's org has VERIFIED the
 *      email's domain (DNS TXT proof, sso-trust.ts) — the org owns the
 *      domain, so its IdP may assert emails on it.
 *
 * Everything else is rejected. Both outcomes are audited (the sub values are
 * identifiers, kept for forensics): this is the guard that turns "any IdP
 * asserting your email" from a silent account takeover into a 409.
 */
export const resolveIdentityConflict = async (
  existing: ExistingIdentity,
  session: SessionUser,
): Promise<"link" | "reject"> => {
  const emailProven =
    session.emailVerified === true ||
    session.federatedProvider === "Google" ||
    // Cheapest arms first — the SSO arm costs DB lookups.
    (await findSsoOrgForIdentity(
      session.identityProviders ?? [],
      session.email,
    )) !== null;
  const decision: "link" | "reject" = emailProven ? "link" : "reject";

  await recordAuditEvent({
    userId: existing.id,
    userEmail: existing.email,
    action: AUDIT_ACTIONS.UPDATE,
    service: AUDIT_SERVICES.AUTH,
    status: decision === "link" ? AUDIT_STATUS.SUCCESS : AUDIT_STATUS.FAILURE,
    metadata: {
      decision,
      federatedProvider: session.federatedProvider ?? null,
      identityProviders: session.identityProviders ?? null,
      emailVerified: session.emailVerified ?? null,
      sessionSub: session.id,
      previousExternalAuthId: existing.externalAuthId,
    },
  });

  return decision;
};
