import { db, Prisma } from "@onecli/db";
import {
  clampPageLimit,
  decodeCursor,
  toPage,
  type DirectoryPage,
} from "./directory-pagination";
import {
  revokeUserAccess,
  restoreUserAccess,
  type RevocationOutcome,
  type RestoreOutcome,
} from "../sso/cognito-user-service";
import { deleteWorkspace } from "./workspace-service";
import { ASSIGNABLE_MEMBER_ROLES } from "../../services/organization-service";
import { ServiceError } from "../../services/errors";
import { assertEntitled } from "../../lib/entitlements-guard";
import { isEntitled } from "../../lib/entitlements";
import {
  recordAuditEvent,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  type AuditSource,
} from "../../services/audit-service";
import { logger } from "../../lib/logger";
import { invalidateGatewayCacheForOrg } from "../../lib/gateway-invalidate";
import {
  resolveRolesForUsers,
  isRoleManagedByIdp,
  allMappedMemberIds,
} from "./role-mapping-service";

export interface TeamMember {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  /** "active" | "suspended" — suspended members render with a badge. */
  status: string;
  /** Break-glass exemption from the org's require-SSO policy. */
  ssoExempt: boolean;
  /**
   * The role is governed by a group→role mapping (step 15), so manual edits
   * are locked ("managed by your identity provider"). Owners are exempt.
   * Populated by `listMembers` (the team-page view); omitted by the paginated
   * directory/picker reads, which don't surface the lock.
   */
  roleManagedByIdp?: boolean;
  joinedAt: Date;
}

export const listMembers = async (
  organizationId: string,
): Promise<TeamMember[]> => {
  const [members, mappedIds] = await Promise.all([
    db.organizationMember.findMany({
      where: {
        organizationId,
        NOT: { userEmail: { endsWith: "@onecli.internal" } },
      },
      select: {
        userId: true,
        userEmail: true,
        role: true,
        status: true,
        ssoExempt: true,
        createdAt: true,
        user: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    allMappedMemberIds(organizationId),
  ]);

  const managed = new Set(mappedIds);
  return members.map((m) => ({
    userId: m.userId,
    email: m.userEmail,
    name: m.user.name,
    role: m.role,
    status: m.status,
    ssoExempt: m.ssoExempt,
    // Owners are never IdP-managed even when they sit in a mapped group.
    roleManagedByIdp: m.role !== "owner" && managed.has(m.userId),
    joinedAt: m.createdAt,
  }));
};

export interface ListMembersPageParams {
  limit?: number;
  cursor?: string;
  /** Case-insensitive contains over email and display name. */
  q?: string;
  status?: "active" | "suspended";
}

/**
 * The directory read over org members (§3.5 envelope) — same shape and
 * placeholder filter as listMembers, keyset-paginated for API consumers
 * (the group member picker, scripts).
 */
export const listMembersPage = async (
  organizationId: string,
  params: ListMembersPageParams = {},
): Promise<DirectoryPage<TeamMember>> => {
  const limit = clampPageLimit(params.limit);
  const where: Prisma.OrganizationMemberWhereInput = {
    organizationId,
    NOT: { userEmail: { endsWith: "@onecli.internal" } },
  };
  if (params.status) where.status = params.status;
  if (params.q) {
    where.OR = [
      { userEmail: { contains: params.q, mode: "insensitive" } },
      { user: { name: { contains: params.q, mode: "insensitive" } } },
    ];
  }
  if (params.cursor) {
    const pos = decodeCursor(params.cursor);
    if (typeof pos.joinedAt !== "string" || typeof pos.userId !== "string") {
      throw new ServiceError("BAD_REQUEST", "Invalid cursor");
    }
    where.AND = [
      {
        OR: [
          { createdAt: { gt: new Date(pos.joinedAt) } },
          { createdAt: new Date(pos.joinedAt), userId: { gt: pos.userId } },
        ],
      },
    ];
  }

  const members = await db.organizationMember.findMany({
    where,
    select: {
      userId: true,
      userEmail: true,
      role: true,
      status: true,
      ssoExempt: true,
      createdAt: true,
      user: { select: { name: true } },
    },
    orderBy: [{ createdAt: "asc" }, { userId: "asc" }],
    take: limit + 1,
  });

  return toPage(
    members.map((m) => ({
      userId: m.userId,
      email: m.userEmail,
      name: m.user.name,
      role: m.role,
      status: m.status,
      ssoExempt: m.ssoExempt,
      joinedAt: m.createdAt,
    })),
    limit,
    (last) => ({ joinedAt: last.joinedAt.toISOString(), userId: last.userId }),
  );
};

/**
 * Revoke API keys a user can no longer use after losing access in an org. This
 * is best-effort cleanup, not the gate: the authoritative check is the
 * binding-based request-time re-check (`canAccessWorkspaceAsUser`), which denies a
 * key the moment its user loses access. On demotion we drop the demoted admin's
 * keys for workspaces they didn't create (`workspaceScope: "non_owned"`); on removal
 * they lose the org entirely, so we drop their keys for every workspace in it
 * (`"all"` — their own workspaces' keys are already gone via `deleteWorkspace`). The
 * org-scoped key (an admin capability) is dropped in both cases. The gateway has
 * no key→identity cache, so a deleted key fails auth immediately.
 *
 * NOTE (13b): the demotion `"non_owned"` filter still keys off `createdByUserId`,
 * so it can over-revoke a key for a workspace the demoted user was SHARED into and
 * could still use via its binding. That's a safe over-cleanup (never a leak);
 * tightening it to bindings-based is a tracked follow-up.
 */
const revokeKeysForLostAccess = async (
  organizationId: string,
  userId: string,
  userEmail: string,
  reason: "role_change" | "member_removed",
  workspaceScope: "non_owned" | "all",
): Promise<void> => {
  const workspaceFilter =
    workspaceScope === "all"
      ? { organizationId }
      : { organizationId, createdByUserId: { not: userId } };

  try {
    const { count } = await db.apiKey.deleteMany({
      where: {
        userId,
        OR: [
          { scope: "workspace", workspace: workspaceFilter },
          { scope: "organization", organizationId },
        ],
      },
    });

    if (count > 0) {
      await recordAuditEvent({
        organizationId,
        userId,
        userEmail,
        action: AUDIT_ACTIONS.DELETE,
        service: AUDIT_SERVICES.API_KEY,
        metadata: { reason, revokedCount: count },
      });
    }
  } catch (err) {
    // Best-effort: the membership change is the primary operation, and the
    // gateway/API re-check (canAccessWorkspaceAsUser / user_can_manage_workspace)
    // already denies a key once its user loses access. Don't fail the role
    // change or removal if this cleanup errors — just log it.
    logger.error(
      { err, organizationId, userId, reason },
      "failed to revoke API keys after access change",
    );
  }
};

export const changeMemberRole = async (
  organizationId: string,
  targetUserId: string,
  newRole: "admin" | "member",
): Promise<void> => {
  // Role management is the RBAC feature (#66) — on self-host it requires the
  // license (without it, roles are not enforced anywhere, so assigning them
  // would be dead state).
  assertEntitled("rbac");
  if (!ASSIGNABLE_MEMBER_ROLES.has(newRole)) {
    throw new Error("Invalid role");
  }

  const membership = await db.organizationMember.findUnique({
    where: {
      organizationId_userId: { organizationId, userId: targetUserId },
    },
    select: { role: true, userEmail: true },
  });

  if (!membership) {
    throw new Error("User is not a member of this organization");
  }

  if (membership.role === "owner") {
    throw new Error("The owner's role cannot be changed");
  }

  // Once a group→role mapping governs this member (step 15), their role is
  // owned by the IdP — a manual edit would be overwritten on the next sync or
  // login, so reject it up front (mirrors the group-membership lock). Owners
  // are already handled above and are never mapped.
  if (await isRoleManagedByIdp(organizationId, targetUserId)) {
    throw new ServiceError(
      "CONFLICT",
      "This member's role is managed by your identity provider.",
    );
  }

  await db.organizationMember.update({
    where: {
      organizationId_userId: { organizationId, userId: targetUserId },
    },
    data: { role: newRole },
  });

  // Demotion to member: the admin loses the org-wide arm, keeping access only to
  // workspaces they created or hold a binding on — best-effort revoke their keys
  // for workspaces they didn't create (and the org-scoped key). See
  // revokeKeysForLostAccess for the over-revoke caveat.
  if (newRole === "member") {
    await revokeKeysForLostAccess(
      organizationId,
      targetUserId,
      membership.userEmail,
      "role_change",
      "non_owned",
    );
  }
};

/**
 * Reconcile the given users' org roles to their group→role mapping (step 15) —
 * the applier behind the SSO-login, SCIM, and mapping-CRUD triggers.
 *
 * Best-effort per user so it can run in the login / SCIM hot paths without ever
 * breaking them. Skips owners and suspended members (never IdP-managed); a user
 * in no mapped group keeps their current role (unmatched — never stripped);
 * otherwise the role is forced to the winning mapping (up or down), and a
 * demotion to member runs the same key-revoke cleanup as a manual change.
 * `source` attributes the audit to the trigger (sso-login / scim / api).
 */
export const reconcileMemberRoles = async (
  organizationId: string,
  userIds: string[],
  source: AuditSource,
): Promise<void> => {
  // Group→role mappings are licensed (#69). Callers treat reconciliation as
  // best-effort (never throwing into a session flow), so unlicensed means
  // inert, not an error — no EE behavior runs, mapped roles are not applied.
  if (!isEntitled()) return;
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;

  try {
    const desired = await resolveRolesForUsers(organizationId, ids);
    if (desired.size === 0) return; // nobody is in a mapped group

    const members = await db.organizationMember.findMany({
      where: { organizationId, userId: { in: ids } },
      select: { userId: true, role: true, status: true, userEmail: true },
    });

    let changed = 0;
    for (const member of members) {
      if (member.role === "owner" || member.status === "suspended") continue;
      const want = desired.get(member.userId);
      if (!want || want === member.role) continue;
      try {
        await db.organizationMember.update({
          where: {
            organizationId_userId: { organizationId, userId: member.userId },
          },
          data: { role: want },
        });
        if (want === "member") {
          await revokeKeysForLostAccess(
            organizationId,
            member.userId,
            member.userEmail,
            "role_change",
            "non_owned",
          );
        }
        await recordAuditEvent({
          organizationId,
          userId: member.userId,
          userEmail: member.userEmail,
          action: AUDIT_ACTIONS.UPDATE,
          service: AUDIT_SERVICES.MEMBER,
          source,
          metadata: { from: member.role, to: want, trigger: "role-mapping" },
        });
        changed++;
      } catch (err) {
        // Isolate one member's failure so the rest of the batch still reconciles.
        logger.error(
          { err, organizationId, userId: member.userId },
          "role-mapping reconcile failed for member",
        );
      }
    }

    // The gateway reads OrganizationMember.role directly; flush once if anything
    // changed (recordAuditEvent, unlike withAudit, does not flush).
    if (changed > 0) invalidateGatewayCacheForOrg(organizationId);
  } catch (err) {
    // Never break the SSO-login / SCIM / mapping-save path that triggered this.
    logger.error({ err, organizationId }, "role-mapping reconcile failed");
  }
};

/**
 * The workspaces that `removeMember` will permanently DELETE when `userId` leaves
 * `organizationId`: the ones they created, still actively hold their OWN binding
 * on, and that no one else can use. Since 13b usage is bindings-only, a workspace
 * survives if anyone else can still reach it —
 *   • `some: { userId }` — the leaver still holds their own binding. If it was
 *     removed (an admin took them off their own workspace and adopted it), the
 *     workspace is NOT theirs to delete: an admin uses it binding-lessly, so it
 *     survives as an admin-owned workspace rather than being destroyed.
 *   • `none: { OR: [...] }` — no binding belongs to anyone else: another user's
 *     direct binding (`userId: { not }`) or any group binding (`groupId: { not:
 *     null }` — group rows have a null userId, so this arm is what catches them).
 * Shared by `removeMember` (the deletion) and the leave-org dialog (the "will be
 * permanently deleted" acknowledgement) so the warning always matches reality.
 */
export const findDeletablePersonalWorkspaces = async (
  organizationId: string,
  userId: string,
): Promise<
  { id: string; name: string | null; channelApps: { provider: string }[] }[]
> => {
  const workspaces = await db.workspace.findMany({
    where: {
      organizationId,
      createdByUserId: userId,
      accessBindings: {
        some: { userId },
        none: {
          OR: [{ userId: { not: userId } }, { groupId: { not: null } }],
        },
      },
    },
    select: {
      id: true,
      name: true,
      // Deleting the workspace uninstalls each agent's chat app from the
      // workspace, so the acknowledgement can name them (offboarding is
      // exactly when someone needs to know that).
      agents: { select: { channels: { select: { provider: true } } } },
    },
    orderBy: { createdAt: "asc" },
  });

  return workspaces.map(({ agents, ...workspace }) => ({
    ...workspace,
    channelApps: (agents ?? []).flatMap((agent) => agent.channels ?? []),
  }));
};

export const removeMember = async (
  organizationId: string,
  targetUserId: string,
  options?: {
    /**
     * Also disable the target's Cognito login when the org owns the identity
     * (admin-initiated offboarding). Voluntary self-leave passes false — a
     * user who chooses to leave keeps their own login.
     */
    revokeIdentity?: boolean;
  },
): Promise<RevocationOutcome> => {
  const membership = await db.organizationMember.findUnique({
    where: {
      organizationId_userId: { organizationId, userId: targetUserId },
    },
    select: {
      role: true,
      userEmail: true,
      user: { select: { externalAuthId: true } },
    },
  });

  if (!membership) {
    throw new Error("User is not a member of this organization");
  }

  if (membership.role === "owner") {
    throw new Error("The organization owner cannot be removed");
  }

  // Ownership inputs must be computed BEFORE the membership row is deleted.
  const membershipCount = await db.organizationMember.count({
    where: { userId: targetUserId },
  });

  // Delete only the leaver's TRULY-PERSONAL workspaces (same set the leave-org
  // dialog acknowledges — see findDeletablePersonalWorkspaces).
  const userWorkspaces = await findDeletablePersonalWorkspaces(
    organizationId,
    targetUserId,
  );

  for (const workspace of userWorkspaces) {
    await deleteWorkspace(workspace.id);
  }

  // The user is leaving the org entirely — revoke any remaining keys (keys for
  // their own workspaces are already gone with those workspaces above).
  await revokeKeysForLostAccess(
    organizationId,
    targetUserId,
    membership.userEmail,
    "member_removed",
    "all",
  );

  // Revoke the shares they hold INTO other people's workspaces, plus their group
  // memberships (a group binding grants workspace access too). Their own workspaces'
  // bindings already cascade-deleted with those workspaces above. Without this,
  // re-inviting the user later would silently resurrect every old share. Scoped
  // to this org so shares in their other orgs are untouched.
  await db.workspaceAccess.deleteMany({
    where: { userId: targetUserId, workspace: { organizationId } },
  });
  await db.groupMember.deleteMany({
    where: { userId: targetUserId, group: { organizationId } },
  });

  await db.organizationMember.delete({
    where: {
      organizationId_userId: { organizationId, userId: targetUserId },
    },
  });

  // Best-effort Cognito revocation AFTER the removal succeeded — never
  // disable a login for a removal that then failed.
  if (options?.revokeIdentity === false) return "skipped";
  return revokeUserAccess({
    userId: targetUserId,
    externalAuthId: membership.user.externalAuthId,
    organizationId,
    membershipCount,
  });
};

/**
 * Suspend a member: every authorization check treats them as a non-member
 * from the next request on (session, API keys, gateway), while their
 * workspaces, keys, and settings stay intact — the reversible alternative to
 * `removeMember`. When the org owns their identity (sole-org SSO user),
 * their Cognito login is also disabled + globally signed out (best-effort;
 * the DB flip is the real gate and always lands first).
 */
export const suspendMember = async (
  organizationId: string,
  targetUserId: string,
  actingUserId: string,
): Promise<RevocationOutcome> => {
  if (targetUserId === actingUserId) {
    throw new ServiceError("BAD_REQUEST", "You cannot suspend yourself");
  }

  const membership = await db.organizationMember.findUnique({
    where: {
      organizationId_userId: { organizationId, userId: targetUserId },
    },
    select: {
      role: true,
      status: true,
      user: { select: { externalAuthId: true } },
    },
  });

  if (!membership) {
    throw new ServiceError(
      "NOT_FOUND",
      "User is not a member of this organization",
    );
  }
  if (membership.role === "owner") {
    throw new ServiceError(
      "BAD_REQUEST",
      "The organization owner cannot be suspended",
    );
  }
  if (membership.status === "suspended") {
    throw new ServiceError("CONFLICT", "This member is already suspended");
  }

  const membershipCount = await db.organizationMember.count({
    where: { userId: targetUserId },
  });

  await db.organizationMember.update({
    where: {
      organizationId_userId: { organizationId, userId: targetUserId },
    },
    data: { status: "suspended", suspendedAt: new Date() },
  });

  return revokeUserAccess({
    userId: targetUserId,
    externalAuthId: membership.user.externalAuthId,
    organizationId,
    membershipCount,
  });
};

/** Reverse a suspension; re-enables the Cognito login if we disabled it. */
export const reinstateMember = async (
  organizationId: string,
  targetUserId: string,
): Promise<RestoreOutcome> => {
  const membership = await db.organizationMember.findUnique({
    where: {
      organizationId_userId: { organizationId, userId: targetUserId },
    },
    select: { status: true, user: { select: { externalAuthId: true } } },
  });

  if (!membership) {
    throw new ServiceError(
      "NOT_FOUND",
      "User is not a member of this organization",
    );
  }
  if (membership.status !== "suspended") {
    throw new ServiceError("CONFLICT", "This member is not suspended");
  }

  await db.organizationMember.update({
    where: {
      organizationId_userId: { organizationId, userId: targetUserId },
    },
    data: { status: "active", suspendedAt: null },
  });

  // Active again: re-resolve their role against current mappings (one may have
  // changed while they were suspended) (step 15).
  await reconcileMemberRoles(organizationId, [targetUserId], AUDIT_SOURCE.API);

  return restoreUserAccess({
    userId: targetUserId,
    externalAuthId: membership.user.externalAuthId,
  });
};

/**
 * Toggle the break-glass exemption from the org's require-SSO policy.
 * Owners CAN be exempt — that's the point of break-glass (the UI recommends
 * keeping at least one exempt owner).
 */
export const setMemberSsoExempt = async (
  organizationId: string,
  targetUserId: string,
  ssoExempt: boolean,
): Promise<void> => {
  // SSO break-glass exemptions belong to the SSO feature (#75).
  assertEntitled("sso");
  const membership = await db.organizationMember.findUnique({
    where: {
      organizationId_userId: { organizationId, userId: targetUserId },
    },
    select: { userId: true },
  });
  if (!membership) {
    throw new ServiceError(
      "NOT_FOUND",
      "User is not a member of this organization",
    );
  }

  await db.organizationMember.update({
    where: {
      organizationId_userId: { organizationId, userId: targetUserId },
    },
    data: { ssoExempt },
  });
};
