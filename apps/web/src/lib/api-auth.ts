import { cookies } from "next/headers";
import { db } from "@onecli/db";
import { validateApiKey } from "@/lib/validate-api-key";
import { getServerSession } from "@/lib/auth/server";
import { findUserDefaultProject } from "@/lib/services/organization-service";

const ACTIVE_PROJECT_COOKIE = "onecli-project-id";

export interface AuthContext {
  userId: string;
  projectId: string;
}

/**
 * Resolve the authenticated user + account from an API request.
 * Tries API key first (`Authorization: Bearer oc_...`), then falls back to session.
 * For session auth, respects the active project cookie when the user belongs to
 * multiple orgs, falling back to the default project if no cookie is set.
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
    select: {
      id: true,
      organizationMemberships: {
        select: { organizationId: true },
      },
    },
  });
  if (!user) return null;

  const memberOrgIds = user.organizationMemberships.map(
    (m) => m.organizationId,
  );

  const cookieStore = await cookies();
  const cookieProjectId = cookieStore.get(ACTIVE_PROJECT_COOKIE)?.value;

  if (cookieProjectId) {
    const project = await db.project.findFirst({
      where: {
        id: cookieProjectId,
        organizationId: { in: memberOrgIds },
      },
      select: { id: true },
    });
    if (project) return { userId: user.id, projectId: project.id };
  }

  const fallback = await findUserDefaultProject(user.id);
  if (!fallback) return null;

  return { userId: user.id, projectId: fallback.id };
};
