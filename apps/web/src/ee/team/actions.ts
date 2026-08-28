"use server";

import { revalidatePath } from "next/cache";
import { db } from "@onecli/db";
import {
  resolveOrgContext,
  requireOrgAdminContext,
} from "@/lib/actions/resolve-user";
import {
  requireRole,
  getUserRole,
  type OrgRole,
} from "@onecli/api/ee/services/authorization-service";
import {
  withAudit,
  type AuditAction,
  type AuditService,
} from "@onecli/api/services/audit-service";
import { changeMemberRole } from "@onecli/api/ee/services/team-service";
import { safeAction, type ActionResult } from "@/lib/safe-action";

export const getOrgSubscriptionStatus = async (): Promise<string> => {
  const { organizationId } = await requireOrgAdminContext();
  const org = await db.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { subscriptionStatus: true },
  });
  return org.subscriptionStatus;
};

export const getUserOrgRole = async (): Promise<OrgRole> => {
  try {
    const { userId, organizationId } = await resolveOrgContext();
    const role = await getUserRole(userId, organizationId);
    return role ?? "member";
  } catch {
    return "member";
  }
};

export const changeTeamMemberRole = async (
  targetUserId: string,
  newRole: "admin" | "member",
): Promise<ActionResult> => {
  return safeAction(async () => {
    const { userId, userEmail, organizationId } = await resolveOrgContext();
    await requireRole(userId, organizationId, "admin");

    await withAudit(
      () => changeMemberRole(organizationId, targetUserId, newRole),
      () => ({
        organizationId,
        userId,
        userEmail,
        action: "update" as AuditAction,
        service: "team" as AuditService,
        metadata: { targetUserId, newRole },
      }),
    );

    revalidatePath("/", "layout");
  });
};
