"use server";

import { randomUUID } from "crypto";
import { db } from "@onecli/db";
import { requireRole } from "@onecli/api/ee/services/authorization-service";
import { getServerSession } from "@/lib/auth/server";

export const getAwsExternalId = async (
  organizationId: string,
): Promise<string> => {
  const session = await getServerSession();
  if (!session) throw new Error("Not authenticated");

  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: { id: true },
  });
  if (!user) throw new Error("User not found");

  // Org AWS identity is an org-level connection concern — restrict to
  // admins/owners. requireRole throws (ServiceError FORBIDDEN) for members and
  // non-members alike, so it subsumes the old membership check. This action is
  // only ever reached from the org-scoped (admin-locked) Global Connections
  // page; the workspace-scoped connect flow never passes an orgId.
  await requireRole(user.id, organizationId, "admin");

  const org = await db.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { awsExternalId: true },
  });

  if (org.awsExternalId) return org.awsExternalId;

  const externalId = `onecli-${randomUUID()}`;

  await db.organization.update({
    where: { id: organizationId },
    data: { awsExternalId: externalId },
  });

  return externalId;
};
