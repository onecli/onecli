import { db } from "@onecli/db";

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
  if (!headerProjectId) return null;

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
    select: { id: true },
  });

  return project?.id ?? null;
};
