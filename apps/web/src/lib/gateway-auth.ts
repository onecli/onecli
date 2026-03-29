import type { GatewayFetchOptions } from "@/lib/gateway-auth-types";

export type { GatewayFetchOptions };

export const GATEWAY_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:10255";

/** Auth options for browser → gateway HTTP API calls. */
export const getGatewayFetchOptions =
  async (): Promise<GatewayFetchOptions> => ({
    headers: {},
    credentials: "include",
  });
