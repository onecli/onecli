import type { NextRequest } from "next/server";

const GATEWAY_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:10255";

/**
 * Invalidate the gateway's CONNECT response cache for the current user's
 * account. Forwards the request's auth headers (API key or session cookie)
 * to the gateway so it can resolve the account.
 *
 * Fire-and-forget — failures are silently ignored. The cache will expire
 * naturally via TTL if the gateway is unreachable.
 */
export const invalidateGatewayCache = (request: NextRequest) => {
  const authorization = request.headers.get("authorization");
  const cookie = request.headers.get("cookie");

  const headers: Record<string, string> = {};
  if (authorization) headers["authorization"] = authorization;
  if (cookie) headers["cookie"] = cookie;

  fetch(`${GATEWAY_URL}/api/cache/invalidate`, {
    method: "POST",
    headers,
  }).catch(() => {});
};
