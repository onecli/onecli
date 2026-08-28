import { db } from "@onecli/db";
import type { SessionEnforcer } from "../../providers";
import { emailDomainOf } from "../services/org-domain-service";
import { findSsoOrgForIdentity } from "./sso-trust";

/** Single user-facing message for a session rejected by "require SSO" (401). */
export const SSO_REQUIRED_ERROR =
  "Your organization requires single sign-on. Sign in through your identity provider.";

export const SSO_REQUIRED_CODE = "sso_required";

/**
 * The cloud SessionEnforcer: enterprise "require SSO", applied to every
 * authenticated session. A session whose email domain is verified for an org
 * with `ssoRequired` is rejected unless
 * it arrived through that org's own SSO connection (the identityProviders[]
 * scan — sso-trust's two-leg rule) or the member holds the `ssoExempt`
 * break-glass flag. Domain-keyed on purpose: non-members of the enforcing
 * org are rejected too (they can only enter via SSO, which JIT-joins them).
 *
 * Sessions only — API keys carry no sign-in identity, so `ssoRequired`
 * never gates them; suspension/removal are what kill keys.
 *
 * FAIL-CLOSED: DB errors propagate to the caller (a 500), never allow.
 */
export const enforceSsoSession: SessionEnforcer = async (session, user) => {
  const domain = emailDomainOf(user.email);
  if (!domain) return null;

  // The hot path: one indexed lookup answering "is this domain enforced?" —
  // `domain` is globally unique, so at most one org can match.
  const enforced = await db.organizationDomain.findFirst({
    where: {
      domain,
      verifiedAt: { not: null },
      organization: { ssoRequired: true },
    },
    select: { organizationId: true },
  });
  if (!enforced) return null;

  // Arrived through the enforcing org's own SSO connection? (Zero queries
  // for non-SSO sessions — the provider-prefix gate short-circuits.)
  const ssoOrg = await findSsoOrgForIdentity(
    session.identityProviders ?? [],
    user.email,
  );
  if (ssoOrg?.organizationId === enforced.organizationId) return null;

  // Break-glass: an exempt membership may keep its non-SSO sign-in.
  const membership = await db.organizationMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId: enforced.organizationId,
        userId: user.id,
      },
    },
    select: { ssoExempt: true },
  });
  if (membership?.ssoExempt) return null;

  return { error: SSO_REQUIRED_ERROR, code: SSO_REQUIRED_CODE };
};
