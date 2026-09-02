import { db } from "@onecli/db";
import { isEntitled } from "../../lib/entitlements";
import { emailDomainOf } from "../services/org-domain-service";

/**
 * SSO trust lookups shared by the login lookup endpoint, the JIT membership
 * service, and the identity-relink policy. One trust rule everywhere, the
 * same JOIN the PreSignUp Lambda enforces: an identity provider is trusted
 * for an email only when the provider's
 * connection is live (not disabled) AND the email's domain is verified for
 * that SAME org. Cross-org assertions (org B's IdP claiming a@orgA.com)
 * fail the second leg.
 */

interface SsoOrgIdentity {
  organizationId: string;
  connectionId: string;
  cognitoProviderName: string;
}

/**
 * Session identity providers that could be org SSO connections. Provider
 * names are minted lowercase (`org-<24 hex>`), but the pool is
 * case-insensitive, so tokens may carry any casing — compare lowercased.
 */
const orgProviderCandidates = (identityProviders: string[]): string[] =>
  identityProviders
    .map((name) => name.toLowerCase())
    .filter((name) => name.startsWith("org-"));

/**
 * The org whose live SSO connection matches one of the session's identity
 * providers AND whose verified domains cover the session email. Null when
 * the session isn't an SSO session or the trust legs don't hold. Costs zero
 * queries for non-SSO sessions (the provider-prefix gate runs first).
 */
export const findSsoOrgForIdentity = async (
  identityProviders: string[],
  email: string,
): Promise<SsoOrgIdentity | null> => {
  // Unlicensed ⇒ no SSO vouch, even where EE data exists (a connection
  // created while licensed must not keep vouching after the flag drops).
  // Soft null, not a throw: the free identity-conflict guard calls this on
  // the sign-in path, and null simply means "no trust" there — the
  // reconcileMemberRoles posture. Also skips both trust queries.
  if (!isEntitled()) return null;
  const candidates = orgProviderCandidates(identityProviders);
  if (candidates.length === 0) return null;

  const domain = emailDomainOf(email);
  if (!domain) return null;

  const connection = await db.organizationSsoConnection.findFirst({
    where: {
      cognitoProviderName: { in: candidates },
      status: { not: "disabled" },
    },
    select: { id: true, organizationId: true, cognitoProviderName: true },
  });
  if (!connection) return null;

  const verifiedDomain = await db.organizationDomain.findFirst({
    where: {
      organizationId: connection.organizationId,
      domain,
      verifiedAt: { not: null },
    },
    select: { id: true },
  });
  if (!verifiedDomain) return null;

  return {
    organizationId: connection.organizationId,
    connectionId: connection.id,
    cognitoProviderName: connection.cognitoProviderName,
  };
};

/**
 * Home-realm discovery for the login page: does this email's domain belong
 * to an org with a live SSO connection? Reveals only the domain→provider
 * mapping (standard HRD) plus whether that org REQUIRES SSO (`enforced` —
 * the login page uses it to refuse the OTP fallback) — never whether a
 * user exists.
 */
export const lookupSsoForEmail = async (
  email: string,
): Promise<{ provider: string; enforced: boolean } | null> => {
  const domain = emailDomainOf(email);
  if (!domain) return null;

  // `domain` is globally unique: at most one org can own it.
  const domainRow = await db.organizationDomain.findFirst({
    where: { domain, verifiedAt: { not: null } },
    select: {
      organizationId: true,
      organization: { select: { ssoRequired: true } },
    },
  });
  if (!domainRow) return null;

  const connection = await db.organizationSsoConnection.findFirst({
    where: {
      organizationId: domainRow.organizationId,
      status: { not: "disabled" },
    },
    select: { cognitoProviderName: true },
  });
  if (!connection) return null;

  return {
    provider: connection.cognitoProviderName,
    enforced: domainRow.organization.ssoRequired,
  };
};
