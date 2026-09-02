"use server";

import { cookies } from "next/headers";
import { db } from "@onecli/db";
import { activeMembershipWhere } from "@onecli/api/services/organization-service";
import { getServerSession } from "@/lib/auth/server";
import { DEFAULT_ORG_COOKIE } from "./constants";

export const getUserDefaultOrgId = async (): Promise<string | null> => {
  const org = await getUserDefaultOrg();
  return org?.id ?? null;
};

/** The default org with its display name — for surfaces that must NAME the
 * org a click will act on (the Slack finish-install confirm). */
export const getUserDefaultOrg = async (): Promise<{
  id: string;
  name: string;
} | null> => {
  const session = await getServerSession();
  if (!session) return null;

  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: {
      organizationMemberships: {
        where: activeMembershipWhere,
        select: {
          organizationId: true,
          organization: { select: { name: true } },
        },
        orderBy: { createdAt: "asc" as const },
      },
    },
  });
  if (!user || user.organizationMemberships.length === 0) return null;

  const memberships = user.organizationMemberships;

  const cookieStore = await cookies();
  const cookieOrg = cookieStore.get(DEFAULT_ORG_COOKIE)?.value;
  const picked = cookieOrg
    ? memberships.find((m) => m.organizationId === cookieOrg)
    : undefined;
  const chosen = picked ?? memberships[0]!;
  return { id: chosen.organizationId, name: chosen.organization.name };
};
