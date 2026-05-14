import { db } from "@onecli/db";
import { API_URL } from "./env";

const GATEWAY_URL = API_URL;

export const invalidateGatewayCache = (request: Request) => {
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
