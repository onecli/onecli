import { db } from "@onecli/db";
import { getGatewayInternalUrl } from "./env";

export const invalidateGatewayCache = (request: Request) => {
  const authorization = request.headers.get("authorization");
  const cookie = request.headers.get("cookie");
  // Forward the workspace the request was scoped to. The cloud gateway requires
  // X-Workspace-Id for session (Cognito) auth — without it the flush 401s (and
  // previously hit the user's *default* workspace instead of this one). API-key
  // auth ignores it (the key carries its workspace), so this is safe for the
  // SDK/CLI and for OSS.
  const workspaceId = request.headers.get("x-workspace-id");

  const headers: Record<string, string> = {};
  if (authorization) headers["authorization"] = authorization;
  if (cookie) headers["cookie"] = cookie;
  if (workspaceId) headers["x-workspace-id"] = workspaceId;

  fetch(`${getGatewayInternalUrl()}/v1/cache/invalidate`, {
    method: "POST",
    headers,
  }).catch(() => {});
};

/**
 * Flush the gateway's cached config for specific API keys directly. Use this
 * when the keys are about to be — or have just been — deleted, so they can no
 * longer be looked up from the database: capture them first, then flush.
 */
export const invalidateGatewayCacheForKeys = (keys: string[]) => {
  for (const key of keys) {
    fetch(`${getGatewayInternalUrl()}/v1/cache/invalidate`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
    }).catch(() => {});
  }
};

export const invalidateGatewayCacheForAccount = (workspaceId: string) => {
  db.apiKey
    .findFirst({ where: { workspaceId }, select: { key: true } })
    .then((apiKey) => {
      if (!apiKey) return;
      invalidateGatewayCacheForKeys([apiKey.key]);
    })
    .catch(() => {});
};

export const invalidateGatewayCacheForOrg = (organizationId: string) => {
  db.apiKey
    .findMany({
      where: { workspace: { organizationId } },
      select: { key: true },
      distinct: ["workspaceId"],
    })
    .then((keys) => invalidateGatewayCacheForKeys(keys.map((k) => k.key)))
    .catch(() => {});
};
