import { db } from "@onecli/db";
import { CAPS } from "../../lib/env";
import {
  activeMembershipWhere,
  findUserDefaultProject,
} from "../../services/organization-service";
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
    where: { userId, organizationId: headerOrgId, ...activeMembershipWhere },
    select: { organizationId: true },
  });

  return membership?.organizationId ?? null;
};

/**
 * Whether a user holds a ProjectAccess binding on a project — directly or via a
 * group they belong to. Mirrors the EE authz service's `hasProjectAccessBinding`
 * (this shared file can't import cloud code); only reached under `CAPS.rbac`.
 */
const hasProjectBinding = async (
  userId: string,
  projectId: string,
): Promise<boolean> => {
  const binding = await db.projectAccess.findFirst({
    where: {
      projectId,
      OR: [{ userId }, { group: { members: { some: { userId } } } }],
    },
    select: { id: true },
  });
  return binding !== null;
};

/**
 * Whether a user may access a project: an admin/owner of the project's
 * organization, or an active member granted access through a ProjectAccess
 * binding (direct or via a group). Bindings are the sole usage gate since step
 * 13b — the creator arm was dropped. Non-RBAC editions (oss, onprem) enforce no
 * roles, so this is a no-op there (always allowed). Shared by `resolveProjectId`
 * (session project resolution) and the API-key auth path so both gate access
 * identically — and so a key keeps working only while its user still has access.
 */
export const canAccessProjectAsUser = async (
  userId: string,
  project: {
    id: string;
    organizationId: string;
  },
): Promise<boolean> => {
  if (!CAPS.rbac) return true;
  const resolver = getRoleResolver();
  const role = resolver
    ? await resolver.getUserRole(userId, project.organizationId)
    : null;
  // Only an ACTIVE member can reach a project. Suspended/non-members read as
  // no-role → denied — and a binding never rescues them: the binding check lives
  // *inside* this active-member gate, so a suspended user's stale binding is
  // never consulted (the suspension invariant). Keep it that way. An active
  // member passes iff org-admin or holding a ProjectAccess binding.
  if (!role) return false;
  if (ROLE_HIERARCHY[role] >= ROLE_HIERARCHY.admin) return true;
  return hasProjectBinding(userId, project.id);
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
          where: activeMembershipWhere,
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
    select: { id: true, organizationId: true },
  });

  if (!project) return null;

  // Multi-org (cloud): a member may only target projects they hold a binding on;
  // admins and owners may target any project in their org. Non-multi-org editions
  // register no role resolver, so this gate is skipped and any in-org project is
  // accepted, as before. Mirrors `canAccessProject` in the EE authz service.
  if (!(await canAccessProjectAsUser(userId, project))) return null;

  return project.id;
};
