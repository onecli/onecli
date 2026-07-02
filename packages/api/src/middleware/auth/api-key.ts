import { db } from "@onecli/db";
import type { AuthContext } from "../../providers";
import { getRoleResolver, ROLE_HIERARCHY } from "../../providers";
import { CAPS } from "../../lib/env";
import { resolveUserEmail, canAccessProjectAsUser } from "./resolve";

export const authenticateApiKey = async (
  request: Request,
  requireProject: boolean,
): Promise<AuthContext | null> => {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token || !token.startsWith("oc_")) return null;

  // Org key (oc_org_*)
  if (token.startsWith("oc_org_")) {
    const apiKey = await db.apiKey.findUnique({
      where: { key: token },
      select: { userId: true, organizationId: true, scope: true },
    });
    if (!apiKey || apiKey.scope !== "organization" || !apiKey.organizationId)
      return null;

    // Org keys are an admin capability — re-check the key's user still holds
    // admin/owner in the org (only when RBAC is active; non-RBAC editions enforce
    // no roles). Closes the gap where a key keeps working after a demotion.
    if (CAPS.rbac) {
      const resolver = getRoleResolver();
      const role = resolver
        ? await resolver.getUserRole(apiKey.userId, apiKey.organizationId)
        : null;
      if (!role || ROLE_HIERARCHY[role] < ROLE_HIERARCHY.admin) return null;
    }

    const userEmail = await resolveUserEmail(apiKey.userId);
    const headerProjectId = request.headers.get("x-project-id");

    if (requireProject && !headerProjectId) return null;

    if (headerProjectId) {
      const project = await db.project.findFirst({
        where: {
          id: headerProjectId,
          organizationId: apiKey.organizationId,
        },
        select: { id: true },
      });
      if (!project) return null;

      return {
        userId: apiKey.userId,
        userEmail,
        projectId: project.id,
        organizationId: apiKey.organizationId,
      };
    }

    return {
      userId: apiKey.userId,
      userEmail,
      projectId: undefined,
      organizationId: apiKey.organizationId,
    };
  }

  // Project key (oc_*)
  const apiKey = await db.apiKey.findUnique({
    where: { key: token },
    select: { userId: true, projectId: true },
  });
  if (!apiKey || !apiKey.projectId) return null;

  const project = await db.project.findUnique({
    where: { id: apiKey.projectId },
    select: { createdByUserId: true, organizationId: true },
  });
  if (!project) return null;

  // Re-check access at request time: the key authenticates only while its user
  // still has access to the project (creator, or org admin/owner). OSS is a
  // no-op (single-user, no role resolver). Mirrors resolveProjectId.
  if (!(await canAccessProjectAsUser(apiKey.userId, project))) return null;

  const userEmail = await resolveUserEmail(apiKey.userId);

  return {
    userId: apiKey.userId,
    userEmail,
    projectId: apiKey.projectId,
    organizationId: project.organizationId,
  };
};
