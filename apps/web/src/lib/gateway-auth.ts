import { IS_CLOUD } from "@/lib/env";
import { getAuthToken, getWorkspaceId } from "@/lib/api-fetch";
import type { GatewayFetchOptions } from "@/lib/gateway-auth-types";

export type { GatewayFetchOptions };

/**
 * Auth options for browser → gateway HTTP API calls.
 *
 * Cloud sends the Cognito ID token as a Bearer header and the active workspace
 * as `X-Workspace-Id` (read from the `/w/<id>/` URL). Cloud is multi-workspace, so
 * the gateway requires the workspace explicitly and never falls back to a
 * default — see the gateway's `AuthUser` extractor. No cookies needed; cloud
 * uses token-based auth, not session cookies.
 *
 * Onprem rides the session cookie instead (`credentials: "include"`).
 */
export const getGatewayFetchOptions =
  async (): Promise<GatewayFetchOptions> => {
    if (!IS_CLOUD) {
      // The session cookie authenticates the user, but without an explicit
      // workspace the gateway falls back to the user's default (oldest)
      // workspace — so approvals and vault state in any OTHER workspace would
      // be invisible from its own pages. Send the active workspace from the
      // `/w/<id>/` URL; the gateway validates membership on the header.
      const workspaceId = getWorkspaceId();
      return {
        headers: workspaceId ? { "X-Workspace-Id": workspaceId } : {},
        credentials: "include",
      };
    }

    const headers: Record<string, string> = {};

    const token = await getAuthToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const workspaceId = getWorkspaceId();
    if (workspaceId) {
      headers["X-Workspace-Id"] = workspaceId;
    }

    return { headers };
  };
