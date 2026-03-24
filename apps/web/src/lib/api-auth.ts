import { db } from "@onecli/db";
import { validateApiKey } from "@/lib/validate-api-key";
import { getServerSession } from "@/lib/auth/server";

export interface AuthContext {
  userId: string;
  accountId: string;
}

/**
 * Resolve the authenticated user + account from an API request.
 * Tries API key first (`Authorization: Bearer oc_...`), then falls back to session.
 */
export const resolveApiAuth = async (
  request: Request,
): Promise<AuthContext | null> => {
  // API key auth — returns userId + accountId directly
  const apiKeyAuth = await validateApiKey(request);
  if (apiKeyAuth) return apiKeyAuth;

  // Session auth — resolve from membership
  const session = await getServerSession();
  if (!session) return null;

  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: {
      id: true,
      memberships: { select: { accountId: true }, take: 1 },
    },
  });

  if (!user || user.memberships.length === 0) return null;

  return { userId: user.id, accountId: user.memberships[0]!.accountId };
};
