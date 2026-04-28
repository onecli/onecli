import { db } from "@onecli/db";

export interface ApiKeyAuth {
  userId: string;
  projectId: string;
}

/**
 * Validate an API key from a request's `Authorization: Bearer oc_...` header.
 * Looks up the ApiKey table, returns { userId, projectId } if valid.
 */
export const validateApiKey = async (
  request: Request,
): Promise<ApiKeyAuth | null> => {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token || !token.startsWith("oc_")) return null;

  const apiKey = await db.apiKey.findUnique({
    where: { key: token },
    select: { userId: true, projectId: true },
  });

  if (!apiKey) return null;

  return { userId: apiKey.userId, projectId: apiKey.projectId };
};
