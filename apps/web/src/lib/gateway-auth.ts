import type { GatewayFetchOptions } from "@/lib/gateway-auth-types";

export type { GatewayFetchOptions };

/** Auth options for browser → gateway HTTP API calls. */
export const getGatewayFetchOptions =
  async (): Promise<GatewayFetchOptions> => ({
    headers: {},
    credentials: "include",
  });
