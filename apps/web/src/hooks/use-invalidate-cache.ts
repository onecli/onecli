import { useCallback } from "react";
import { getGatewayFetchOptions } from "@/lib/gateway-auth";

const GATEWAY_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:10255";

/**
 * Returns a fire-and-forget function that invalidates the gateway's
 * CONNECT cache for the current account. Call after any mutation that
 * changes secrets, policy rules, or agent-secret assignments so that
 * agents pick up changes immediately instead of waiting for the
 * 60-second cache TTL.
 */
export const useInvalidateGatewayCache = () => {
  return useCallback(async () => {
    try {
      const { headers, credentials } = await getGatewayFetchOptions();
      await fetch(`${GATEWAY_URL}/api/cache/invalidate`, {
        method: "POST",
        headers,
        credentials,
      });
    } catch {
      // Fire-and-forget — don't break UI if gateway is unreachable
    }
  }, []);
};
