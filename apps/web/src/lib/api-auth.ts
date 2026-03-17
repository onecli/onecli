import { db } from "@onecli/db";
import { validateApiKey } from "@/lib/validate-api-key";
import { getServerSession } from "@/lib/auth/server";

/**
 * Resolve the authenticated user from an API request.
 * Tries API key first (`Authorization: Bearer oc_...`), then falls back to session.
 */
export const resolveApiAuth = async (
  request: Request,
): Promise<{ userId: string } | null> => {
  const apiKeyUser = await validateApiKey(request);
  if (apiKeyUser) return { userId: apiKeyUser.id };

  const session = await getServerSession();
  if (!session) return null;

  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: { id: true },
  });

  return user ? { userId: user.id } : null;
};
