import { db } from "@onecli/db";
import type { AuthContext } from "../../providers";
import { getSessionProvider } from "../../providers";
import {
  resolveOrganizationId,
  resolveOrganizationIdFromProject,
  resolveProjectId,
} from "./resolve";

export const authenticateSession = async (
  request: Request,
  requireProject: boolean,
): Promise<AuthContext | null> => {
  const session = getSessionProvider();
  const user = await session.getSession(request);
  if (!user) return null;

  const dbUser = await db.user.findUnique({
    where: { externalAuthId: user.id },
    select: { id: true },
  });
  if (!dbUser) return null;

  const projectId = await resolveProjectId(request, dbUser.id);

  if (!projectId && requireProject) return null;

  if (projectId) {
    const organizationId = await resolveOrganizationIdFromProject(projectId);
    if (!organizationId) return null;

    return {
      userId: dbUser.id,
      userEmail: user.email,
      projectId,
      organizationId,
    };
  }

  const organizationId = await resolveOrganizationId(request, dbUser.id);
  if (!organizationId) return null;

  return {
    userId: dbUser.id,
    userEmail: user.email,
    projectId: undefined,
    organizationId,
  };
};
