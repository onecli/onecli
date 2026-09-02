"use server";

import { revalidatePath } from "next/cache";
import {
  resolveOrgContext,
  requireOrgAdminContext,
} from "@/lib/actions/resolve-user";
import {
  requireRole,
  getUserRole,
} from "@onecli/api/ee/services/authorization-service";
import {
  withAudit,
  type AuditAction,
  type AuditService,
} from "@onecli/api/services/audit-service";
import {
  listMembers,
  removeMember,
  findDeletablePersonalWorkspaces,
  type TeamMember,
} from "@onecli/api/ee/services/team-service";
import { safeAction, type ActionResult } from "@/lib/safe-action";

export const getTeamMembers = async (): Promise<TeamMember[]> => {
  const { organizationId } = await requireOrgAdminContext();
  return listMembers(organizationId);
};

export const removeTeamMember = async (
  targetUserId: string,
): Promise<ActionResult> => {
  return safeAction(async () => {
    const { userId, userEmail, organizationId } = await resolveOrgContext();
    await requireRole(userId, organizationId, "admin");

    if (targetUserId === userId) {
      throw new Error("You cannot remove yourself from the organization");
    }

    await withAudit(
      () => removeMember(organizationId, targetUserId),
      () => ({
        organizationId,
        userId,
        userEmail,
        action: "delete" as AuditAction,
        service: "team" as AuditService,
        metadata: { removedUserId: targetUserId },
      }),
    );

    revalidatePath("/", "layout");
  });
};

/**
 * The workspaces that leaving the org will permanently delete — the caller's
 * truly-personal ones (created + still solely theirs). Since 13b, a workspace
 * they shared with someone else, or were removed from and an admin adopted,
 * survives, so it is NOT listed here. Powers the leave-org acknowledgement, and
 * is the exact set `removeMember` deletes (both call the same helper).
 */
export const getWorkspacesDeletedOnLeave = async (): Promise<
  { id: string; name: string | null; channelApps: { provider: string }[] }[]
> => {
  const { userId, organizationId } = await resolveOrgContext();
  return findDeletablePersonalWorkspaces(organizationId, userId);
};

/**
 * The same set for ANOTHER member — what removing them will permanently
 * delete, and which chat apps that uninstalls. Admin-gated: the caller must
 * already be able to manage the org's members.
 */
export const getWorkspacesDeletedOnRemove = async (
  targetUserId: string,
): Promise<
  { id: string; name: string | null; channelApps: { provider: string }[] }[]
> => {
  const { userId, organizationId } = await resolveOrgContext();
  // Same gate as `removeTeamMember` itself: this reports what removal would
  // destroy, so it must not be readable by a non-admin.
  await requireRole(userId, organizationId, "admin");
  return findDeletablePersonalWorkspaces(organizationId, targetUserId);
};

export const leaveTeam = async (): Promise<ActionResult> => {
  return safeAction(async () => {
    const { userId, userEmail, organizationId } = await resolveOrgContext();
    const role = await getUserRole(userId, organizationId);

    if (role === "owner") {
      throw new Error("An organization requires at least 1 owner");
    }

    await withAudit(
      // Voluntary departure — never disable the leaver's own login.
      () => removeMember(organizationId, userId, { revokeIdentity: false }),
      () => ({
        organizationId,
        userId,
        userEmail,
        action: "delete" as AuditAction,
        service: "team" as AuditService,
        metadata: { leftOrganization: true },
      }),
    );

    revalidatePath("/", "layout");
  });
};
