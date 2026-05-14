import { db } from "@onecli/db";

export interface ApiKeyAuth {
  userId: string;
  projectId: string;
}

export interface OrgKeyAuth {
  userId: string;
  organizationId: string;
}

const validateOrgApiKey = async (
  request: Request,
  token: string,
): Promise<ApiKeyAuth | null> => {
  const apiKey = await db.apiKey.findUnique({
    where: { key: token },
    select: { userId: true, organizationId: true, scope: true },
  });

  if (!apiKey || apiKey.scope !== "organization" || !apiKey.organizationId)
    return null;

  const projectId = request.headers.get("x-project-id");
  if (!projectId) return null;

  const project = await db.project.findFirst({
    where: { id: projectId, organizationId: apiKey.organizationId },
    select: { id: true },
  });
  if (!project) return null;

  return { userId: apiKey.userId, projectId: project.id };
};

export const validateApiKey = async (
  request: Request,
): Promise<ApiKeyAuth | null> => {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token || !token.startsWith("oc_")) return null;

  if (token.startsWith("oc_org_")) {
    return validateOrgApiKey(request, token);
  }

  const apiKey = await db.apiKey.findUnique({
    where: { key: token },
    select: { userId: true, projectId: true },
  });

  if (!apiKey || !apiKey.projectId) return null;

  return { userId: apiKey.userId, projectId: apiKey.projectId };
};

export const validateOrgKeyOnly = async (
  request: Request,
): Promise<OrgKeyAuth | null> => {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token || !token.startsWith("oc_org_")) return null;

  const apiKey = await db.apiKey.findUnique({
    where: { key: token },
    select: { userId: true, organizationId: true, scope: true },
  });

  if (!apiKey || apiKey.scope !== "organization" || !apiKey.organizationId)
    return null;

  return { userId: apiKey.userId, organizationId: apiKey.organizationId };
};
