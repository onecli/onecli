"use server";

import { cookies } from "next/headers";
import { db } from "@onecli/db";
import { activeMembershipWhere } from "@onecli/api/services/organization-service";
import { getServerSession } from "@/lib/auth/server";
import { DEFAULT_ORG_COOKIE } from "./constants";

export const getUserDefaultOrgId = async (): Promise<string | null> => {
  const session = await getServerSession();
  if (!session) return null;

  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: {
      organizationMemberships: {
        where: activeMembershipWhere,
        select: { organizationId: true },
        orderBy: { createdAt: "asc" as const },
      },
    },
  });
  if (!user || user.organizationMemberships.length === 0) return null;

  const memberOrgIds = user.organizationMemberships.map(
    (m) => m.organizationId,
  );

  const cookieStore = await cookies();
  const cookieOrg = cookieStore.get(DEFAULT_ORG_COOKIE)?.value;
  if (cookieOrg && memberOrgIds.includes(cookieOrg)) return cookieOrg;

  return memberOrgIds[0]!;
};
