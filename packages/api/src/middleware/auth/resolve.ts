import { db } from "@onecli/db";
import { IS_CLOUD } from "../../lib/env";
import { findUserDefaultProject } from "../../services/organization-service";
import { getRoleResolver, ROLE_HIERARCHY } from "../../providers";

export const resolveUserEmail = async (userId: string): Promise<string> => {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  return user?.email ?? "";
};

export const resolveOrganizationIdFromProject = async (
  projectId: string,
): Promise<string | null> => {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true },
  });
  return project?.organizationId ?? null;
};

export const resolveOrganizationId = async (
  request: Request,
  userId: string,
): Promise<string | null> => {
  const headerOrgId = request.headers.get("x-organization-id");
  if (!headerOrgId) return null;

  const membership = await db.organizationMember.findFirst({
    where: { userId, organizationId: headerOrgId },
    select: { organizationId: true },
  });

  return membership?.organizationId ?? null;
};

export const resolveProjectId = async (
  request: Request,
  userId: string,
): Promise<string | null> => {
  const headerProjectId = request.headers.get("x-project-id");
  if (!headerProjectId) {
    if (IS_CLOUD) return null;
    const fallback = await findUserDefaultProject(userId);
    return fallback?.id ?? null;
  }

  const memberOrgIds = await db.user
    .findUnique({
      where: { id: userId },
      select: {
        organizationMemberships: {
          select: { organizationId: true },
        },
      },
    })
    .then((u) => u?.organizationMemberships.map((m) => m.organizationId) ?? []);

  const project = await db.project.findFirst({
    where: {
      id: headerProjectId,
      organizationId: { in: memberOrgIds },
    },
    select: { id: true, organizationId: true, createdByUserId: true },
  });

  if (!project) return null;

  // Cloud: a member may only target projects they created; admins and owners
  // may target any project in their org. OSS standalone registers no role
  // resolver, so this gate is skipped and any in-org project is accepted, as
  // before. Mirrors `canManageAllProjects` in the cloud authorization service.
  if (IS_CLOUD && project.createdByUserId !== userId) {
    const resolver = getRoleResolver();
    const role = resolver
      ? await resolver.getUserRole(userId, project.organizationId)
      : null;
    if (!role || ROLE_HIERARCHY[role] < ROLE_HIERARCHY.admin) {
      return null;
    }
  }

  return project.id;
};
