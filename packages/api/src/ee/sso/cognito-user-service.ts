import {
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminUserGlobalSignOutCommand,
  ListUsersCommand,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { db } from "@onecli/db";
import { cognitoClient } from "../clients/cognito-client";
import { CAPS, COGNITO_USER_POOL_ID } from "../../lib/env";
import { logger } from "../../lib/logger";

const log = logger.child({ component: "cognito-user" });

/**
 * Cognito USER lifecycle (disable / enable / global sign-out) for member
 * suspension and removal. Everything here is BEST-EFFORT: the DB membership
 * change is the real access gate (every
 * authorization check filters suspended members), so a Cognito failure must
 * never abort it. Callers get an outcome for audit metadata instead.
 *
 * Revocation tail (doc-verified): AdminDisableUser blocks new sign-ins and
 * revokes refresh tokens; AdminUserGlobalSignOut revokes all tokens at
 * Cognito's own endpoints — but locally-JWKS-verified access/ID tokens stay
 * valid until expiry (≤1h in our pool config). The suspension checks are
 * what close that window for org data.
 */

/**
 * `externalAuthId` values that are not Cognito subs: provision/SCIM
 * placeholders and the local-auth user. Never call Cognito for these —
 * a SCIM-provisioned user who has never signed in has no Cognito profile
 * until the first real sign-in binds one.
 */
const PLACEHOLDER_AUTH_ID_PREFIXES = ["provision-", "scim-", "local-"];

export type RevocationOutcome =
  | "disabled" // org owns the identity → signed out + disabled + deactivatedAt
  | "membership_only" // identity not org-owned (multi-org / non-SSO) → DB-level only
  | "skipped" // no Cognito in this edition, placeholder id, or user not found
  | "failed"; // Cognito errored — logged, membership change unaffected

export type RestoreOutcome = "enabled" | "skipped" | "failed";

const errorName = (err: unknown): string =>
  err instanceof Error ? err.name : "";

const cognitoUnavailable = (): boolean =>
  CAPS.auth !== "cognito" || !COGNITO_USER_POOL_ID;

const isPlaceholderAuthId = (externalAuthId: string): boolean =>
  PLACEHOLDER_AUTH_ID_PREFIXES.some((p) => externalAuthId.startsWith(p));

interface ResolvedCognitoUser {
  username: string;
  /** providerName of every `identities` entry, as stored (federated only). */
  providerNames: string[];
}

const providerNamesFromIdentities = (
  identitiesJson: string | undefined,
): string[] => {
  if (!identitiesJson) return [];
  try {
    const parsed: unknown = JSON.parse(identitiesJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      const name = (entry as { providerName?: unknown }).providerName;
      return typeof name === "string" && name.length > 0 ? [name] : [];
    });
  } catch {
    return [];
  }
};

/**
 * sub → the profile's exact Username + federated provider names, via
 * ListUsers (the canonical resolution: admin APIs accept a sub only for
 * LOCAL users, and federated usernames aren't reconstructable from our DB).
 * Null when no profile matches.
 */
export const resolveCognitoUser = async (
  sub: string,
  client: CognitoIdentityProviderClient = cognitoClient,
): Promise<ResolvedCognitoUser | null> => {
  // Subs are our stored UUIDs, but never interpolate untrusted characters
  // into a ListUsers filter string.
  if (sub.includes('"') || sub.includes("\\")) return null;

  const page = await client.send(
    new ListUsersCommand({
      UserPoolId: COGNITO_USER_POOL_ID,
      Filter: `sub = "${sub}"`,
      Limit: 1,
    }),
  );
  const user = page.Users?.[0];
  if (!user?.Username) return null;

  const identitiesJson = user.Attributes?.find(
    (a) => a.Name === "identities",
  )?.Value;

  return {
    username: user.Username,
    providerNames: providerNamesFromIdentities(identitiesJson),
  };
};

export interface RevokeUserAccessParams {
  userId: string;
  externalAuthId: string;
  organizationId: string;
  /**
   * The target's total org-membership count BEFORE the suspend/remove
   * mutation — the caller computes it (removal deletes the row, so the
   * service can't). Sole-org (=== 1) is one leg of "the org owns this
   * identity".
   */
  membershipCount: number;
}

/**
 * Disable + globally sign out the target's Cognito login — ONLY when the org
 * owns the identity: the target's sole org membership is this org AND the
 * profile's `identities` carry this org's SSO provider. Multi-org users and
 * non-SSO identities get membership-level suspension only. Never throws.
 */
export const revokeUserAccess = async (
  params: RevokeUserAccessParams,
  client: CognitoIdentityProviderClient = cognitoClient,
): Promise<RevocationOutcome> => {
  if (cognitoUnavailable() || isPlaceholderAuthId(params.externalAuthId)) {
    return "skipped";
  }
  if (params.membershipCount !== 1) return "membership_only";

  try {
    const connection = await db.organizationSsoConnection.findFirst({
      where: { organizationId: params.organizationId },
      select: { cognitoProviderName: true },
    });
    if (!connection) return "membership_only";

    const cognitoUser = await resolveCognitoUser(params.externalAuthId, client);
    if (!cognitoUser) {
      log.warn(
        { userId: params.userId },
        "no Cognito profile for sub — nothing to revoke",
      );
      return "skipped";
    }

    // Provider names are minted lowercase but the pool is case-insensitive —
    // compare lowercased, like the rest of the SSO trust code.
    const orgProvider = connection.cognitoProviderName.toLowerCase();
    const ownedBySso = cognitoUser.providerNames.some(
      (name) => name.toLowerCase() === orgProvider,
    );
    if (!ownedBySso) return "membership_only";

    // Sign out BEFORE disabling — sign-out against an already-disabled
    // profile is undocumented behavior.
    await client.send(
      new AdminUserGlobalSignOutCommand({
        UserPoolId: COGNITO_USER_POOL_ID,
        Username: cognitoUser.username,
      }),
    );
    await client.send(
      new AdminDisableUserCommand({
        UserPoolId: COGNITO_USER_POOL_ID,
        Username: cognitoUser.username,
      }),
    );

    await db.user.update({
      where: { id: params.userId },
      data: { deactivatedAt: new Date() },
    });

    return "disabled";
  } catch (err) {
    if (errorName(err) === "UserNotFoundException") return "skipped";
    log.error(
      { err, userId: params.userId, organizationId: params.organizationId },
      "Cognito revocation failed — membership change stands without it",
    );
    return "failed";
  }
};

/**
 * Undo a step-9 deactivation on reinstate: re-enable the Cognito login and
 * clear `deactivatedAt`. No-op unless this user was actually deactivated.
 * Re-enabling does NOT resurrect previously revoked tokens (doc-verified) —
 * the user simply signs in again. Never throws.
 */
export const restoreUserAccess = async (
  params: { userId: string; externalAuthId: string },
  client: CognitoIdentityProviderClient = cognitoClient,
): Promise<RestoreOutcome> => {
  if (cognitoUnavailable() || isPlaceholderAuthId(params.externalAuthId)) {
    return "skipped";
  }

  try {
    const user = await db.user.findUnique({
      where: { id: params.userId },
      select: { deactivatedAt: true },
    });
    if (!user?.deactivatedAt) return "skipped";

    const cognitoUser = await resolveCognitoUser(params.externalAuthId, client);
    if (cognitoUser) {
      await client.send(
        new AdminEnableUserCommand({
          UserPoolId: COGNITO_USER_POOL_ID,
          Username: cognitoUser.username,
        }),
      );
    }

    // Clear the flag even when the profile is gone — there is nothing left
    // to re-enable, and a stale timestamp would misreport the user's state.
    await db.user.update({
      where: { id: params.userId },
      data: { deactivatedAt: null },
    });

    return cognitoUser ? "enabled" : "skipped";
  } catch (err) {
    log.error(
      { err, userId: params.userId },
      "Cognito re-enable failed — reinstate stands without it",
    );
    return "failed";
  }
};
