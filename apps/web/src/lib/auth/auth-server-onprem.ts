import { headers } from "next/headers";
import { getOnpremAuth } from "@onecli/api/lib/better-auth";
import { readExternalAuthId } from "@onecli/api/lib/better-auth-contract";
import type { AuthUser } from "./types";

/**
 * The non-cloud server session: a signed-in identity read from the request's
 * session cookie, or nobody.
 *
 * The cookie is validated in-process against the shared database — the same
 * `better-auth` configuration the api-server mounts, built from the same
 * factory — so there is no HTTP hop back to the API just to learn who is
 * asking.
 */
export const getServerSessionImpl = async (): Promise<AuthUser | null> => {
  const session = await getOnpremAuth().api.getSession({
    headers: await headers(),
  });

  const user = session?.user;
  if (!user?.email) return null;

  // Identity is `externalAuthId` everywhere downstream, never better-auth's
  // own row id (see the session provider).
  const id = readExternalAuthId(user);
  if (!id) return null;

  return { id, email: user.email, name: user.name ?? undefined };
};
