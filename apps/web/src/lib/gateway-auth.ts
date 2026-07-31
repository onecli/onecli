import type { GatewayFetchOptions } from "@/lib/gateway-auth-types";
import { getApiKey } from "@/lib/actions/api-key";

export type { GatewayFetchOptions };

/**
 * Auth options for browser → gateway HTTP API calls.
 *
 * The gateway's `AuthUser` extractor (`apps/gateway/src/auth.rs`) tries
 * `Authorization: Bearer oc_...` first, before any session/cookie check. In
 * `local` mode (single-user dev, no login) that API key is the *only*
 * credential the gateway accepts — there is no session to fall back to — so
 * we always fetch/provision the caller's key here via the same
 * `ensureApiKey`-backed action the API Keys settings page uses, and attach
 * it. This is a no-op in `oauth` mode too: sending a valid key alongside the
 * session cookie just gives the gateway a stronger credential to check first.
 */
export const getGatewayFetchOptions =
  async (): Promise<GatewayFetchOptions> => {
    const { apiKey } = await getApiKey();
    return {
      headers: { Authorization: `Bearer ${apiKey}` },
      credentials: "include",
    };
  };
