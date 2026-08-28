"use server";

import { revalidatePath } from "next/cache";
import { db } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";
import { requireOrgAdminContext } from "@/lib/actions/resolve-user";
import {
  setDefaultOrgCookie,
  clearDefaultOrgCookie,
} from "@/lib/auth/set-active-scope";
import {
  createOrganization,
  deleteOrganization,
  validateOrgName,
} from "@onecli/api/ee/services/organization-service";
import { activeMembershipWhere } from "@onecli/api/services/organization-service";
import { enforceSsoSession } from "@onecli/api/ee/sso/sso-enforcement";
import { logger } from "@onecli/api/lib/logger";
import { safeAction, type ActionResult } from "@/lib/safe-action";

const log = logger.child({ component: "settings-actions" });

const requireUser = async () => {
  const session = await getServerSession();
  if (!session) throw new Error("Not authenticated");
  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: { id: true, email: true, name: true },
  });
  if (!user) throw new Error("User not found");
  // Server actions are POST endpoints any authenticated session can invoke —
  // mirror the /v1/auth/session "require SSO" enforcement here too (this file
  // mutates org settings incl. the gateway policy mode).
  const denial = await enforceSsoSession(session, user);
  if (denial) throw new Error(denial.error);
  return user;
};

export interface OrgData {
  id: string;
  name: string;
  slug: string;
  role: string;
  subscriptionStatus: string;
  workspaces: {
    id: string;
    name: string | null;
    channelApps: { provider: string }[];
  }[];
}

export const getOrganizationData = async (): Promise<OrgData | null> => {
  const user = await requireUser();

  const { organizationId } = await requireOrgAdminContext();

  const membership = await db.organizationMember.findUnique({
    where: {
      organizationId_userId: { organizationId, userId: user.id },
    },
    select: {
      role: true,
      status: true,
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
          subscriptionStatus: true,
          workspaces: {
            select: {
              id: true,
              name: true,
              // Deleting the org uninstalls every agent's chat app from the
              // workspace — the confirmation names them.
              agents: { select: { channels: { select: { provider: true } } } },
            },
          },
        },
      },
    },
  });

  if (!membership || membership.status === "suspended") return null;

  return {
    id: membership.organization.id,
    name: membership.organization.name,
    slug: membership.organization.slug,
    role: membership.role,
    subscriptionStatus: membership.organization.subscriptionStatus,
    workspaces: membership.organization.workspaces.map(
      ({ agents, ...workspace }) => ({
        ...workspace,
        channelApps: agents.flatMap((agent) => agent.channels),
      }),
    ),
  };
};

export const deleteOrganizationAction = async (
  organizationId: string,
): Promise<ActionResult<{ redirectTo: string }>> => {
  return safeAction(async () => {
    const user = await requireUser();

    log.info(
      { organizationId, userId: user.id, userEmail: user.email },
      "organization deletion requested",
    );

    await deleteOrganization(organizationId, user.id);

    const remainingMembership = await db.organizationMember.findFirst({
      where: { userId: user.id, ...activeMembershipWhere },
      select: {
        organizationId: true,
        organization: {
          select: {
            workspaces: {
              where: { createdByUserId: user.id },
              select: { id: true },
              orderBy: { createdAt: "asc" },
              take: 1,
            },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    if (remainingMembership) {
      await setDefaultOrgCookie(remainingMembership.organizationId);
    } else {
      await clearDefaultOrgCookie();
    }

    revalidatePath("/", "layout");

    return {
      redirectTo: remainingMembership
        ? `/org/${remainingMembership.organizationId}/workspaces`
        : "/create-org",
    };
  });
};

export const updateOrganizationAction = async (
  organizationId: string,
  data: { name: string },
): Promise<ActionResult<{ id: string; name: string; slug: string }>> => {
  return safeAction(async () => {
    const user = await requireUser();

    const membership = await db.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId, userId: user.id },
      },
      select: { role: true, status: true },
    });
    if (
      !membership ||
      membership.status === "suspended" ||
      membership.role !== "owner"
    ) {
      throw new Error("Only the organization owner can update it");
    }

    const trimmed = validateOrgName(data.name);

    const result = await db.organization.update({
      where: { id: organizationId },
      data: { name: trimmed },
      select: { id: true, name: true, slug: true },
    });

    revalidatePath("/org/[orgId]", "layout");

    return result;
  });
};

export const createOrganizationAction = async (
  name: string,
): Promise<ActionResult<{ redirectTo: string }>> => {
  return safeAction(async () => {
    const user = await requireUser();

    const trimmed = validateOrgName(name);

    const { workspace, organization: org } = await createOrganization(
      user.id,
      user.email,
      trimmed,
    );

    await db.user.update({
      where: { id: user.id },
      data: { onboardingCompletedAt: new Date() },
    });

    await setDefaultOrgCookie(org.id);

    return { redirectTo: `/w/${workspace.id}/overview` };
  });
};
