import { IS_CLOUD } from "@/lib/env";
import type { AuthUser } from "./types";

/**
 * Edition dispatcher for the server session. Both arms load lazily: the
 * Cognito module runs `createServerRunner` at module scope (it must never
 * load outside cloud), and the self-hosted module pulls in the database-backed
 * session reader — neither belongs in the other edition's server graph. The
 * chosen arm is resolved once per process and memoized here.
 */
let implPromise: Promise<() => Promise<AuthUser | null>> | null = null;

const loadImpl = (): Promise<() => Promise<AuthUser | null>> =>
  (implPromise ??= (
    IS_CLOUD
      ? import("@/ee/auth/cognito-server")
      : import("@/lib/auth/auth-server-onprem")
  ).then((m) => m.getServerSessionImpl));

export const getServerSessionImpl = async (): Promise<AuthUser | null> =>
  (await loadImpl())();
