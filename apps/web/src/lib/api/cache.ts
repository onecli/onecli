// Gateway CONNECT-cache invalidation. Flushing the gateway's app-injection /
// connect cache for the active project lets agents pick up secret, rule,
// agent-assignment, and connection changes immediately instead of waiting out
// the cache TTL.
//
// Like the approvals and 1Password value pickers, this hits the gateway
// directly (different base URL + auth than the typed JSON API), so it uses
// getGatewayApiUrl() + getGatewayFetchOptions() — the edition-aware seam that
// authenticates as the ACTING USER: the Cognito ID token + X-Project-Id in
// cloud, session-cookie credentials in OSS. The gateway scopes the flush to
// that authenticated principal's project (its AuthUser extractor), so there is
// no need to look up — or borrow — an API key from the database.
import { getGatewayApiUrl } from "@/hooks/use-vault-status";
import { getGatewayFetchOptions } from "@/lib/gateway-auth";

/**
 * Flush the gateway cache for the current project. Fire-and-forget: a failed
 * flush must never break the UI, and the cache also expires on its own TTL.
 */
export const invalidateGatewayCache = async (): Promise<void> => {
  try {
    const { headers, credentials } = await getGatewayFetchOptions();
    await fetch(`${getGatewayApiUrl()}/v1/cache/invalidate`, {
      method: "POST",
      headers,
      credentials,
    });
  } catch {
    // Gateway unreachable — ignore.
  }
};
