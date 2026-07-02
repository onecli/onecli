import type { AuthUser } from "./types";

/**
 * The fixed local-auth identity used by the all-in-one image in `local` auth
 * mode (oss + onprem). Single source of truth so the login path (`auth-server`)
 * and the eager onprem boot init reference the same user.
 */
export const LOCAL_AUTH_ID = "local-admin";

export const LOCAL_USER: AuthUser = {
  id: LOCAL_AUTH_ID,
  email: "admin@localhost",
  name: "Admin",
};
