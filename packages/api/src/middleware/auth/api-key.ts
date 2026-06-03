import { db } from "@onecli/db";
import type { AuthContext } from "../../providers";
import { resolveUserEmail, resolveOrganizationIdFromProject } from "./resolve";

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

  const organizationId = await resolveOrganizationIdFromProject(
    apiKey.projectId,
  );
  if (!organizationId) return null;

  const userEmail = await resolveUserEmail(apiKey.userId);

  return {
    userId: apiKey.userId,
    userEmail,
    projectId: apiKey.projectId,
    organizationId,
  };
};
