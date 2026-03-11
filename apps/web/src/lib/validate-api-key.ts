import { db } from "@onecli/db";

interface ApiKeyUser {
  id: string;
  email: string;
  name: string | null;
  externalAuthId: string;
}

/**
 * Validate an API key from a request's `Authorization: Bearer oc_...` header.
 * Returns the user if valid, null otherwise.
 *
 * Usage in API routes:
 * ```ts
 * const user = await validateApiKey(request);
 * if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
 * ```
 */
export const validateApiKey = async (
  request: Request,
): Promise<ApiKeyUser | null> => {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;

  if (!token || !token.startsWith("oc_")) return null;

  const user = await db.user.findUnique({
    where: { apiKey: token },
    select: { id: true, email: true, name: true, externalAuthId: true },
  });

  return user;
};
