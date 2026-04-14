import { useCallback } from "react";
import { invalidateGatewayCache } from "@/lib/actions/gateway-cache";

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
      await invalidateGatewayCache();
    } catch {
      // Fire-and-forget — don't break UI if gateway is unreachable
    }
  }, []);
};
