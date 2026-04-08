import type { GatewayFetchOptions } from "@/lib/gateway-auth-types";
import { API_URL } from "@/lib/env";

export type { GatewayFetchOptions };

export const GATEWAY_URL = API_URL;

/** Auth options for browser → gateway HTTP API calls. */
export const getGatewayFetchOptions =
  async (): Promise<GatewayFetchOptions> => ({
    headers: {},
    credentials: "include",
  });
