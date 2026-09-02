import type { SessionProvider, SessionUser } from "../providers/types";
import { logger } from "./logger";
import { getOnpremAuth } from "./better-auth";
import { readExternalAuthId } from "./better-auth-contract";

/**
 * The self-hosted (onprem) browser-session provider — the standalone
 * api-server's counterpart to the web app's session dispatch.
 *
 * Every request is resolved from the session cookie. There is no unauthenticated
 * arm: a self-hosted deployment signs people in or it serves nobody.
 *
 * better-auth verifies the cookie signature and reads the backing `sessions`
 * row, so a revoked or expired session resolves to nothing the moment its row
 * is gone — no token lifetime to wait out.
 *
 * The returned `id` is `externalAuthId`, NOT better-auth's own user id: that
 * is the identity the API middleware and the gateway resolve users by
 * (`middleware/auth/session.ts`, `db::find_user_by_external_auth_id`). It is
 * stamped on every user row at creation, so a session without one means a row
 * predating that guarantee — treated as unauthenticated rather than guessed at.
 */
const cookieSession = async (request: Request): Promise<SessionUser | null> => {
  let auth: ReturnType<typeof getOnpremAuth>;
  try {
    auth = getOnpremAuth();
  } catch (err) {
    // The identity layer could not be built at all — a missing secret, or a
    // deployment that should not be using this provider. Still fail closed,
    // but say so: silently answering "not signed in" makes a configuration
    // problem look exactly like an anonymous visitor.
    logger.error({ err }, "session auth unavailable — treating as anonymous");
    return null;
  }

  let session: Awaited<ReturnType<typeof auth.api.getSession>>;
  try {
    session = await auth.api.getSession({ headers: request.headers });
  } catch {
    // An unreadable cookie is an anonymous request, not a server error.
    return null;
  }

  const user = session?.user;
  if (!user?.email) return null;

  const externalAuthId = readExternalAuthId(user);
  if (!externalAuthId) return null;

  return {
    id: externalAuthId,
    email: user.email,
    name: user.name ?? undefined,
    emailVerified: user.emailVerified,
  };
};

export const onpremSessionProvider: SessionProvider = {
  getSession: (request) => cookieSession(request),
};
