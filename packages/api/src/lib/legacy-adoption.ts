import { db } from "@onecli/db";
import { BETTER_AUTH_ID_PREFIX } from "./better-auth-contract";
import { IS_CLOUD } from "./env";
import {
  LEGACY_LOCAL_AUTH_ID,
  LEGACY_LOCAL_EMAIL,
} from "./legacy-local-identity";
import { logger } from "./logger";

/**
 * Hand a pre-2.0 deployment's data to the operator's real account.
 *
 * Before logins existed, a self-hosted install ran as one automatically
 * created user (`legacy-local-identity.ts`) that nobody had a password for.
 * Everything the operator built — their organization, workspaces, agents, API
 * keys, conversations — hangs off that row. When they upgrade and register,
 * the identity layer creates a SECOND user for the registration, and the two
 * have to become one.
 *
 * ## Which row survives
 *
 * The legacy row does. `User` is referenced by more than thirty relations and
 * several of them cascade — deleting it would take the operator's agent
 * conversations with it, and the ones that null out would quietly forget who
 * created what. So the freshly created row is the one that goes: it is
 * milliseconds old and owns nothing except the credential and session the
 * registration just produced, both of which move across first.
 *
 * Keeping the legacy row's `id` means every one of those relations is correct
 * by construction rather than by an inventory that could miss one.
 *
 * ## When it runs
 *
 * Only in the one state described by the conditions below, all of which are
 * re-checked while holding a lock on the legacy row. It is self-disarming:
 * adoption overwrites `external_auth_id`, so the state can never match twice.
 */

/** The client inside an interactive transaction. */
export type TxClient = Parameters<Parameters<typeof db.$transaction>[0]>[0];

/** Columns that copy a user's email for display; rewritten alongside the row. */
const rewriteDenormalizedEmails = async (
  tx: TxClient,
  userId: string,
  email: string,
) => {
  // Live references to who this user IS. Historical columns are deliberately
  // untouched — an audit entry, a memory revision or an invitation records who
  // did something at the time, and rewriting that would falsify the record.
  await tx.organizationMember.updateMany({
    where: { userId },
    data: { userEmail: email },
  });
  await tx.apiKey.updateMany({
    where: { userId },
    data: { userEmail: email },
  });
  await tx.workspace.updateMany({
    where: { createdByUserId: userId },
    data: { createdByUserEmail: email },
  });
};

/**
 * Adopt the legacy install on behalf of the just-registered session, if this
 * deployment is in exactly that state. Returns whether adoption happened.
 *
 * Safe to call on every session: outside the one upgrade moment it costs a
 * single indexed lookup that finds nothing.
 */
export const adoptLegacyInstall = async (
  sessionExternalAuthId: string,
  prisma: typeof db = db,
): Promise<boolean> => {
  // (1) Cloud has no legacy local mode to upgrade from and authenticates with
  // Cognito, so this must never run there — asserted here rather than assumed
  // from the caller, because rewriting user rows is not something to leave to
  // wiring.
  if (IS_CLOUD) return false;

  // The overwhelmingly common case is "no legacy row", and it should not cost
  // a transaction or a lock. Everything this finds is re-checked below.
  const candidate = await prisma.user.findUnique({
    where: { externalAuthId: LEGACY_LOCAL_AUTH_ID },
    select: { id: true },
  });
  if (!candidate) return false;

  return prisma.$transaction((tx) =>
    adoptWithinTransaction(tx, sessionExternalAuthId),
  );
};

/**
 * The guarded move itself, inside a caller-supplied transaction.
 *
 * Separated from [`adoptLegacyInstall`] so the proof suite can drive it
 * against real PostgreSQL — the row lock, the foreign keys and the cascades
 * are precisely the parts a mocked client cannot tell the truth about.
 */
export const adoptWithinTransaction = async (
  tx: TxClient,
  sessionExternalAuthId: string,
): Promise<boolean> => {
  // (6) The race fence. Two registrations arriving together both reach this
  // line; one waits. When it resumes, the winner has already rewritten
  // `external_auth_id`, so this predicate no longer matches the row and the
  // loser gets nothing back — it falls through to a normal fresh
  // organization instead of adopting an install that is no longer legacy.
  const locked = await tx.$queryRaw<{ id: string; email: string }[]>`
      SELECT id, email FROM users
      WHERE external_auth_id = ${LEGACY_LOCAL_AUTH_ID}
      FOR UPDATE
    `;
  const legacy = locked[0];
  if (!legacy) return false;

  // (3) The literal legacy identity, both halves. `local-admin` alone is
  // already unforgeable; the email is asserted too so a row that was edited
  // into something else is left alone rather than silently claimed.
  if (legacy.email !== LEGACY_LOCAL_EMAIL) return false;

  // (2) Exactly two users: the legacy row and the registration. One means
  // there is nothing to adopt yet; three or more means this deployment has
  // real accounts on it and is nobody's fresh upgrade.
  if ((await tx.user.count()) !== 2) return false;

  // (4) The legacy row was never a login. A credential or a linked provider
  // would make it somebody's actual account rather than the passwordless
  // placeholder, and merging into it would be taking over their identity.
  if ((await tx.account.count({ where: { userId: legacy.id } })) !== 0) {
    return false;
  }

  // (5) The other row is this request's own, minted by this deployment's
  // identity layer, and owns nothing yet. Requiring "no organization" is
  // what keeps this from ever merging two established users.
  const fresh = await tx.user.findUnique({
    where: { externalAuthId: sessionExternalAuthId },
    select: {
      id: true,
      email: true,
      name: true,
      emailVerified: true,
      image: true,
      externalAuthId: true,
    },
  });
  if (!fresh) return false;
  if (fresh.id === legacy.id) return false;
  if (!fresh.externalAuthId.startsWith(BETTER_AUTH_ID_PREFIX)) return false;
  if (
    (await tx.organizationMember.count({ where: { userId: fresh.id } })) !== 0
  ) {
    return false;
  }

  // ── Move the registration onto the legacy row ────────────────────────

  // The credential carries the password. better-auth keeps its `accountId`
  // equal to the user's id, so that invariant moves with it — scoped to the
  // credential provider, because a social account's `accountId` is the
  // provider's subject and overwriting it would unlink the Google login.
  await tx.account.updateMany({
    where: { userId: fresh.id, providerId: "credential" },
    data: { userId: legacy.id, accountId: legacy.id },
  });
  // Anything else (a linked social account) moves without being rewritten.
  await tx.account.updateMany({
    where: { userId: fresh.id },
    data: { userId: legacy.id },
  });
  // The browser is already holding this session's cookie; moving the row
  // rather than issuing a new one keeps the operator signed in across the
  // adoption.
  await tx.session.updateMany({
    where: { userId: fresh.id },
    data: { userId: legacy.id },
  });

  // Frees the unique email and identity for the update below. Nothing else
  // points at this row — and if anything unexpectedly does, the foreign key
  // makes this throw and roll the whole adoption back, which is the outcome
  // to want: a loud failure the next request retries, never a silent
  // half-move.
  await tx.user.delete({ where: { id: fresh.id } });

  // Taking the registration's own `external_auth_id` rather than minting a
  // fresh one is what makes the session that is already open resolve to this
  // row immediately — no relink, no identity conflict downstream.
  await tx.user.update({
    where: { id: legacy.id },
    data: {
      email: fresh.email,
      name: fresh.name,
      emailVerified: fresh.emailVerified,
      image: fresh.image,
      externalAuthId: fresh.externalAuthId,
    },
  });

  await rewriteDenormalizedEmails(tx, legacy.id, fresh.email);

  logger.info(
    { userId: legacy.id },
    "adopted the pre-2.0 local-admin install into the registered account",
  );
  return true;
};
