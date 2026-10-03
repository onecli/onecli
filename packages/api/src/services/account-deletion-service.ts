import { db } from "@onecli/db";
import { logger } from "../lib/logger";
import {
  invalidateGatewayCacheForKeys,
  invalidateGatewayCacheForOrg,
} from "../lib/gateway-invalidate";
import type { SessionUserContext } from "../middleware/auth/session";
import { ServiceError } from "./errors";
import { dropPrincipalFromPolicyInTx } from "./policy-service";

const log = logger.child({ component: "account-deletion" });

/**
 * What deleting the account does to ONE of the user's organizations.
 *
 *   - `delete`: the user is the only member, so the organization and every
 *     workspace in it go with the account.
 *   - `leave`: someone else is in the org, so the user just leaves it; only
 *     their truly-personal workspaces are deleted (the same set the leave-org
 *     dialog acknowledges).
 *   - `blocked`: the user is an owner and other members exist. Destroying a
 *     shared organization from a personal account page is not offered — they
 *     transfer ownership or remove the members first.
 *
 * Also the wire shape of `GET /v1/user/deletion-impact`.
 */
export interface AccountDeletionOrgImpact {
  organizationId: string;
  name: string;
  outcome: "delete" | "leave" | "blocked";
  otherMemberCount: number;
  /** Workspaces permanently deleted by this outcome (empty when blocked). */
  workspaces: { id: string; name: string | null }[];
}

/**
 * The per-organization consequences of deleting `userId`'s account — the
 * list the delete-account dialog acknowledges, and the decision
 * `deleteAccount` re-derives before destroying anything.
 *
 * The org/team lifecycle stayed licensed; this free service reaches it lazily
 * (a declared `DYNAMIC_SEAMS` entry) so the free build carries no static
 * coupling. Unentitled deployments still run it: a single-org self-hoster
 * deleting their own account is the free lifecycle, and the multi-org licence
 * freeze inside `deleteOrganization` keeps deciding the rest.
 */
export const planAccountDeletion = async (
  userId: string,
): Promise<AccountDeletionOrgImpact[]> => {
  const { findDeletablePersonalWorkspaces } =
    await import("../ee/services/team-service");

  const memberships = await db.organizationMember.findMany({
    where: { userId },
    select: {
      role: true,
      organization: {
        select: {
          id: true,
          name: true,
          members: {
            where: { userId: { not: userId } },
            select: { userId: true },
          },
          workspaces: {
            select: { id: true, name: true },
            orderBy: { createdAt: "asc" },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const impacts: AccountDeletionOrgImpact[] = [];
  for (const { role, organization: org } of memberships) {
    const otherMemberCount = org.members.length;
    if (role === "owner") {
      impacts.push({
        organizationId: org.id,
        name: org.name,
        otherMemberCount,
        outcome: otherMemberCount === 0 ? "delete" : "blocked",
        workspaces: otherMemberCount === 0 ? org.workspaces : [],
      });
      continue;
    }
    const personal = await findDeletablePersonalWorkspaces(org.id, userId);
    impacts.push({
      organizationId: org.id,
      name: org.name,
      otherMemberCount,
      outcome: "leave",
      workspaces: personal.map(({ id, name }) => ({ id, name })),
    });
  }
  return impacts;
};

/**
 * Rows the user AUTHORED in organizations that outlive them — invitations
 * they sent, provisions they minted — belong to the organization, not the
 * person. Both FKs to `users` are RESTRICT, so they must stop naming the user
 * before the row goes; they are re-pointed at the org's owner rather than
 * deleted, because deleting a pending provision's row alone would orphan its
 * placeholder (a seat, a workspace and a live API key the expiry sweep finds
 * only through that row), and a pending invitation is the org's open door,
 * not the departed admin's. The denormalized `*Email` columns keep the
 * historical author. Runs after the leaves and deletes, so every remaining
 * row sits in an org the user no longer belongs to — which always has an
 * owner of its own (the owner role can be neither changed nor removed).
 */
const reassignAuthoredOrgRows = async (userId: string): Promise<void> => {
  const [invitations, provisions] = await Promise.all([
    db.invitation.findMany({
      where: { invitedById: userId },
      select: { organizationId: true },
      distinct: ["organizationId"],
    }),
    db.userProvision.findMany({
      where: { provisionedById: userId },
      select: { organizationId: true },
      distinct: ["organizationId"],
    }),
  ]);
  const organizationIds = new Set(
    [...invitations, ...provisions].map((row) => row.organizationId),
  );

  for (const organizationId of organizationIds) {
    const owner = await db.organizationMember.findFirst({
      where: { organizationId, role: "owner", userId: { not: userId } },
      select: { userId: true },
    });
    if (!owner) {
      // Unreachable by invariant; if the data is broken anyway, the account
      // still gets deleted — the rows go instead of blocking the person.
      log.error(
        { userId, organizationId },
        "organization has no owner to inherit authored rows; deleting them",
      );
      await db.$transaction([
        db.invitation.deleteMany({
          where: { organizationId, invitedById: userId },
        }),
        db.userProvision.deleteMany({
          where: { organizationId, provisionedById: userId },
        }),
      ]);
      continue;
    }
    await db.$transaction([
      db.invitation.updateMany({
        where: { organizationId, invitedById: userId },
        data: { invitedById: owner.userId },
      }),
      db.userProvision.updateMany({
        where: { organizationId, provisionedById: userId },
        data: { provisionedById: owner.userId },
      }),
    ]);
  }
};

/**
 * Delete the user's account, tearing down their organizations on the way out
 * per `planAccountDeletion`. A user is never stuck: the old precondition
 * ("leave every org first") could not be satisfied on self-host, where a user
 * with no org is handed a fresh one on the next session sync.
 *
 * Order matters. Leaves run before deletes: a delete can trip the multi-org
 * licence freeze (owning several orgs unlicensed), and it must fail before
 * any organization is destroyed, not between two of them. A blocked org
 * refuses the whole deletion up front, before anything is touched.
 *
 * Not one transaction — `deleteOrganization` and `removeMember` each run
 * their own bounded transactions (request logs make an org-wide one
 * unbounded). A mid-way failure leaves a partially-departed user whose row
 * is intact, and every step is idempotent, so the retry finishes the job.
 */
export const deleteAccount = async ({
  userId,
  userEmail,
}: SessionUserContext): Promise<void> => {
  const impacts = await planAccountDeletion(userId);
  const blocked = impacts.filter((i) => i.outcome === "blocked");
  if (blocked.length > 0) {
    throw new ServiceError(
      "CONFLICT",
      `You own ${blocked.map((b) => `"${b.name}"`).join(", ")} with other members. Transfer ownership or remove them before deleting your account.`,
    );
  }

  const [{ deleteOrganization }, { removeMember }] = await Promise.all([
    import("../ee/services/organization-service"),
    import("../ee/services/team-service"),
  ]);

  for (const impact of impacts.filter((i) => i.outcome === "leave")) {
    // Voluntary departure — never disable the leaver's own login (they are
    // about to delete it themselves). No audit row: every row this user
    // authored is deleted with the account below (the FK is RESTRICT), so one
    // written here would not survive the request. The org's gateway cache is
    // still flushed, exactly as `withAudit` would have done.
    await removeMember(impact.organizationId, userId, {
      revokeIdentity: false,
    });
    invalidateGatewayCacheForOrg(impact.organizationId);
    log.info(
      { userId, organizationId: impact.organizationId },
      "left organization for account deletion",
    );
  }

  for (const impact of impacts.filter((i) => i.outcome === "delete")) {
    await deleteOrganization(impact.organizationId, userId);
    log.info(
      { userId, organizationId: impact.organizationId },
      "deleted sole-member organization for account deletion",
    );
  }

  // Workspaces the user created in organizations they LEFT survive with no
  // creator (the column is nullable; the FK has no ON DELETE action).
  await db.workspace.updateMany({
    where: { createdByUserId: userId },
    data: { createdByUserId: null },
  });

  await reassignAuthoredOrgRows(userId);

  // The per-user rows that die WITH the user, in one transaction with the
  // row: API keys (flushed from the gateway cache after the commit, or a
  // deleted key keeps being served until its TTL), the provision a claimed
  // placeholder was converted from, the survey, and every audit row the user
  // authored (RESTRICT — which is also why the departures above write none).
  // The identity rows (`sessions`, `accounts`, SSH keys, …) cascade. So do
  // the user's policy identities, which is why the rules naming only this
  // user go first: left identity-less, they would apply to every user of the
  // orgs the user left above.
  const { apiKeys, policyOrgIds } = await db.$transaction(async (tx) => {
    const keys = await tx.apiKey.findMany({
      where: { userId },
      select: { key: true },
    });
    await tx.apiKey.deleteMany({ where: { userId } });
    await tx.userProvision.deleteMany({ where: { userId } });
    await tx.onboardingSurvey.deleteMany({ where: { userId } });
    await tx.auditLog.deleteMany({ where: { userId } });
    const policyOrgIds = await dropPrincipalFromPolicyInTx(tx, {
      kind: "user",
      id: userId,
    });
    await tx.user.delete({ where: { id: userId } });
    return { apiKeys: keys, policyOrgIds };
  });
  invalidateGatewayCacheForKeys(apiKeys.map((k) => k.key));
  policyOrgIds.forEach(invalidateGatewayCacheForOrg);

  log.info({ userId, userEmail }, "user account deleted");
};
