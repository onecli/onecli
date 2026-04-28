import { db } from "@onecli/db";
import { validateApiKey } from "@/lib/validate-api-key";
import { getServerSession } from "@/lib/auth/server";
import { findUserDefaultProject } from "@/lib/services/organization-service";

export interface AuthContext {
  userId: string;
  projectId: string;
}

/**
 * Resolve the authenticated user + account from an API request.
 * Tries API key first (`Authorization: Bearer oc_...`), then falls back to session.
 */
export const resolveApiAuth = async (
  request: Request,
): Promise<AuthContext | null> => {
  const apiKeyAuth = await validateApiKey(request);
  if (apiKeyAuth) return apiKeyAuth;

  const session = await getServerSession();
  if (!session) return null;

  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: { id: true },
  });
  if (!user) return null;

  const project = await findUserDefaultProject(user.id);
  if (!project) return null;

  return { userId: user.id, projectId: project.id };
};
