import { db } from "@onecli/db";
import { validateApiKey } from "@/lib/validate-api-key";
import { getServerSession } from "@/lib/auth/server";
import { getAuthMode } from "@/lib/auth/auth-mode";

export interface AuthContext {
  userId: string;
  accountId: string;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Check whether the request originates from a loopback address.
 * Uses the first entry in x-forwarded-for when present; treats a missing
 * header as loopback (direct localhost connection without a reverse proxy).
 */
const isLoopbackRequest = (request: Request): boolean => {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return !ip || LOOPBACK.has(ip);
};

/**
 * Resolve the authenticated user + account from an API request.
 * Tries API key first (`Authorization: Bearer oc_...`), then falls back to session.
 *
 * In local auth mode, session fallback is restricted to loopback requests
 * to prevent unauthenticated access from other hosts on the network.
 */
export const resolveApiAuth = async (
  request: Request,
): Promise<AuthContext | null> => {
  // API key auth — always accepted regardless of mode
  const apiKeyAuth = await validateApiKey(request);
  if (apiKeyAuth) return apiKeyAuth;

  // In local mode, only allow session fallback from localhost.
  // Non-localhost clients (e.g. VMs on a bridge interface) must use an API key.
  if (getAuthMode() === "local" && !isLoopbackRequest(request)) {
    return null;
  }

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
