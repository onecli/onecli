import type { NextRequest } from "next/server";
import { db } from "@onecli/db";
import { API_URL } from "@/lib/env";

const GATEWAY_URL = API_URL;

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

/**
 * Invalidate the gateway cache using an account ID directly.
 *
 * Looks up an API key for the account to authenticate with the gateway.
 * Useful in contexts where the request doesn't carry user auth headers
 * (e.g., OAuth callback redirects from external providers).
 *
 * Fire-and-forget — failures are silently ignored.
 */
export const invalidateGatewayCacheForAccount = (projectId: string) => {
  db.apiKey
    .findFirst({ where: { projectId }, select: { key: true } })
    .then((apiKey) => {
      if (!apiKey) return;
      fetch(`${GATEWAY_URL}/api/cache/invalidate`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey.key}` },
      }).catch(() => {});
    })
    .catch(() => {});
};

/**
 * Invalidate the gateway cache for all projects in an organization.
 *
 * Org-level changes (secrets, rules, connections) affect every project
 * under the org, so each project's cache entry must be flushed.
 *
 * Fire-and-forget — failures are silently ignored.
 */
export const invalidateGatewayCacheForOrg = (organizationId: string) => {
  db.apiKey
    .findMany({
      where: { project: { organizationId } },
      select: { key: true },
      distinct: ["projectId"],
    })
    .then((keys) => {
      for (const { key } of keys) {
        fetch(`${GATEWAY_URL}/api/cache/invalidate`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}` },
        }).catch(() => {});
      }
    })
    .catch(() => {});
};
