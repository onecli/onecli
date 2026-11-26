import type { AuthContext } from "./providers";
import type { SessionUserContext } from "./middleware/auth/session";

export type ApiEnv = {
  Variables: {
    auth: AuthContext;
    /** Set by `sessionAuth()` — the person only, no tenancy. */
    sessionUser: SessionUserContext;
  };
};
