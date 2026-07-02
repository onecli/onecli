import { db } from "@onecli/db";
import { CAPS } from "../../lib/env";
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

/**
 * Whether a user may access a project: its creator, or an admin/owner of the
 * project's organization. Non-RBAC editions (oss, onprem) enforce no roles, so
 * this is a no-op there (always allowed). Shared by `resolveProjectId` (session
 * project resolution) and the API-key auth path so both gate access identically —
 * and so a key keeps working only while its user still has access.
 */
export const canAccessProjectAsUser = async (
  userId: string,
  project: { createdByUserId: string | null; organizationId: string },
): Promise<boolean> => {
  if (!CAPS.rbac) return true;
  if (project.createdByUserId === userId) return true;
  const resolver = getRoleResolver();
  const role = resolver
    ? await resolver.getUserRole(userId, project.organizationId)
    : null;
  return !!role && ROLE_HIERARCHY[role] >= ROLE_HIERARCHY.admin;
};

export const resolveProjectId = async (
  request: Request,
  userId: string,
): Promise<string | null> => {
  const headerProjectId = request.headers.get("x-project-id");
  if (!headerProjectId) {
    if (CAPS.tenancy === "multi-org") return null;
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

  // Multi-org (cloud): a member may only target projects they created; admins
  // and owners may target any project in their org. Non-multi-org editions
  // register no role resolver, so this gate is skipped and any in-org project is
  // accepted, as before. Mirrors `canManageAllProjects` in the cloud authz service.
  if (!(await canAccessProjectAsUser(userId, project))) return null;

  return project.id;
};
