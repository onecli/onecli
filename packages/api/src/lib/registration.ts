import { APIError } from "better-auth/api";
import { db } from "@onecli/db";
import {
  LEGACY_LOCAL_AUTH_ID,
  LEGACY_LOCAL_EMAIL,
} from "./legacy-local-identity";
import { logger } from "./logger";

/**
 * Who is allowed to create an account on a self-hosted deployment: anyone.
 *
 * Registration is open by design. Every account is provisioned its own
 * organization on first sign-in (`ensureUserOrganization`), fenced from
 * everyone else's, so a new registration takes nothing from existing users —
 * the same posture as the hosted platform. Joining somebody ELSE's
 * organization still goes through an invitation; registering without one
 * simply starts a fresh org of your own. A deployment that must not accept
 * strangers keeps its dashboard behind the network boundary — the product
 * deliberately offers no registration switch.
 *
 * One narrow refusal survives: the pre-2.0 upgrade window, below. It exists to
 * protect an upgrading operator's data, not to keep people out.
 */

/**
 * The refusal, as a token rather than a sentence.
 *
 * It reaches the browser two different ways and only one of them is JSON: a
 * refused social sign-up is turned into a redirect whose `?error=` value is
 * the message with spaces replaced by underscores (`callback.mjs`). A token
 * survives that transformation unchanged, so both surfaces can map the same
 * string to the same copy.
 */
export const SIGNUP_BLOCKED_BY_UPGRADE = "SIGNUP_BLOCKED_BY_UPGRADE";

export interface RegistrationState {
  /**
   * Whether this deployment is still waiting for its first real account. The
   * auth screens key on it: while true they funnel every visitor to the
   * signup form; once false, sign-in and sign-up are both offered.
   */
  firstAccount: boolean;
  /**
   * Whether registering will take over an existing pre-2.0 deployment's
   * organization, workspaces and agents. The signup screen says so — an
   * operator who has been running this instance for months needs to know
   * their data is coming with them, not that they are starting over.
   */
  adoptsExistingInstall: boolean;
}

/**
 * Where this deployment is in its life, and what registering would mean.
 *
 * `firstAccount` in exactly two states:
 *  - no users at all — a fresh install
 *  - one user, and it is the pre-2.0 passwordless row (see
 *    `legacy-local-identity.ts`) that nobody has ever signed in as. The
 *    upgrading operator registers and claims it.
 *
 * "Zero credentials" is what makes the second case a placeholder rather than a
 * person: a row with an `accounts` entry has a password or a linked provider
 * behind it, which means it is somebody's real account and this instance is
 * already established.
 *
 * `take: 2` rather than a count: the answer only ever depends on the first two
 * rows, and the table is unbounded.
 */
export const registrationState = async (
  prisma: typeof db = db,
): Promise<RegistrationState> => {
  const established = { firstAccount: false, adoptsExistingInstall: false };

  const [only, second] = await prisma.user.findMany({
    take: 2,
    select: { id: true, email: true, externalAuthId: true },
  });

  // Nobody yet: a fresh install, and whoever registers is simply first.
  if (!only) return { firstAccount: true, adoptsExistingInstall: false };
  // More than one account: an established, multi-user deployment.
  if (second) return established;

  if (only.externalAuthId !== LEGACY_LOCAL_AUTH_ID) return established;
  if (only.email !== LEGACY_LOCAL_EMAIL) return established;

  const credentials = await prisma.account.count({
    where: { userId: only.id },
  });
  if (credentials !== 0) return established;

  return { firstAccount: true, adoptsExistingInstall: true };
};

/**
 * Refuse a registration that would strand an upgrading operator's data.
 *
 * Thrown, never returned as `false`: the identity layer re-surfaces a thrown
 * `APIError` verbatim on both the password and the social path, while an
 * aborted-by-returning-false creation collapses into a generic
 * "failed to create user" that a browser cannot tell apart from the database
 * being down.
 */
export const signupBlockedByUpgradeError = (): APIError =>
  new APIError("FORBIDDEN", {
    code: SIGNUP_BLOCKED_BY_UPGRADE,
    message: SIGNUP_BLOCKED_BY_UPGRADE,
  });

/**
 * The pre-2.0 upgrade window — the one moment registration refuses anyone.
 *
 * A deployment upgrading from the no-login era carries a passwordless
 * placeholder row whose data (`legacy-adoption.ts`) is handed to the first
 * account that registers. That adoption requires the table to hold EXACTLY the
 * placeholder and the claimer — its safety fence against handing an
 * established instance's data to a stranger. So while an unclaimed placeholder
 * exists AND a registered account is already waiting to claim it, further
 * registrations are refused; the claimer's first sign-in completes the
 * adoption (seconds, normally), which overwrites the placeholder's identity
 * and disarms this guard for good. Without the refusal, a second registrant
 * arriving in that window would make the adoption impossible forever — the
 * operator's organization, agents and conversations would be orphaned with no
 * way back.
 *
 * Called from the identity layer's user-creation hook, which fires for the
 * password path AND for a social sign-in that would create a new user, so no
 * route around it exists.
 *
 * ## If it fires with MORE than one real account
 *
 * That signature means two claimers slipped through together (the same
 * few-milliseconds race the first-account window has always had) and the
 * adoption is now stuck: it will never see exactly-two rows again — and by
 * the time anyone reads the log, each raced claimer's first sign-in has
 * already bootstrapped them a personal organization, which adoption's
 * owns-nothing condition also refuses. The remedy is manual and the log line
 * below says so — to keep the old install's data, delete EVERY registered
 * user row and the organizations bootstrapped for them (returning the table
 * to exactly the placeholder) and register once more; to abandon the old
 * data instead, delete the unclaimed `local-admin` row.
 */
export const assertUpgradeWindowClear = async (
  prisma: typeof db = db,
): Promise<void> => {
  // The overwhelmingly common case is "no placeholder row", and it must stay
  // a single indexed lookup on the sign-up path.
  const legacy = await prisma.user.findUnique({
    where: { externalAuthId: LEGACY_LOCAL_AUTH_ID },
    select: { id: true, email: true },
  });
  if (!legacy) return;
  if (legacy.email !== LEGACY_LOCAL_EMAIL) return;

  // A credential or a linked provider makes it somebody's real account rather
  // than the placeholder — nothing to adopt, nothing to protect.
  const credentials = await prisma.account.count({
    where: { userId: legacy.id },
  });
  if (credentials !== 0) return;

  const claimers = await prisma.user.count({
    where: { id: { not: legacy.id } },
  });
  // The claimer's own registration — the account the adoption is waiting for.
  if (claimers === 0) return;

  if (claimers > 1) {
    logger.error(
      { claimers },
      "sign-up refused: this deployment's pre-2.0 install was never adopted " +
        "and more than one account now exists, so the adoption can no " +
        "longer run. To keep the old install's data, delete every " +
        "registered user row AND the organizations bootstrapped for them " +
        "(returning the table to just the local-admin row), then register " +
        "once more. To abandon the old data instead, delete the local-admin " +
        "row.",
    );
  } else {
    logger.warn(
      "sign-up refused: a pre-2.0 upgrade is mid-adoption — the account " +
        "that registered for it has not completed its first sign-in, which " +
        "is what hands the old install over and reopens registration.",
    );
  }
  throw signupBlockedByUpgradeError();
};
