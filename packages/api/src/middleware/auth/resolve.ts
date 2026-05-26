import { db } from "@onecli/db";
import { findUserDefaultProject } from "../../services/organization-service";

export const resolveUserEmail = async (userId: string): Promise<string> => {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  return user?.email ?? "";
};

export const resolveOrganizationId = async (
  projectId: string,
): Promise<string | null> => {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true },
  });
  return project?.organizationId ?? null;
};

export const resolveProjectId = async (
  request: Request,
  userId: string,
): Promise<string | null> => {
  const headerProjectId = request.headers.get("x-project-id");

  if (headerProjectId) {
    const memberOrgIds = await db.user
      .findUnique({
        where: { id: userId },
        select: {
          organizationMemberships: {
            select: { organizationId: true },
          },
        },
      })
      .then(
        (u) => u?.organizationMemberships.map((m) => m.organizationId) ?? [],
      );

    const project = await db.project.findFirst({
      where: {
        id: headerProjectId,
        organizationId: { in: memberOrgIds },
      },
      select: { id: true },
    });

    if (project) return project.id;
  }

  const fallback = await findUserDefaultProject(userId);
  return fallback?.id ?? null;
};
