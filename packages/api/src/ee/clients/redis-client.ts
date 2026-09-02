import Redis from "ioredis";
import {
  REDIS_HOST,
  REDIS_PORT,
  REDIS_USERNAME,
  REDIS_PASSWORD,
} from "../../lib/env";

const globalForRedis = globalThis as unknown as { onecliRedis?: Redis };

/**
 * Whether this deployment has Redis at all. Self-host runs without it by
 * design — config presence is the signal, not the edition — so callers with
 * a degraded mode check this instead of catching getRedis's throw.
 */
export const hasRedisConfigured = (): boolean => Boolean(REDIS_HOST);

/**
 * Singleton Redis client for the web app.
 * Uses globalThis to survive Next.js dev hot-reloads without leaking connections.
 * Connects as the "web" user with ACL restricted to `api:*` keys.
 * TLS is enabled automatically for ElastiCache endpoints.
 */
export const getRedis = (): Redis => {
  if (!globalForRedis.onecliRedis) {
    if (!REDIS_HOST) throw new Error("REDIS_HOST is not configured");
    globalForRedis.onecliRedis = new Redis({
      host: REDIS_HOST,
      port: Number(REDIS_PORT),
      username: REDIS_USERNAME || undefined,
      password: REDIS_PASSWORD || undefined,
      tls: REDIS_HOST.includes(".cache.amazonaws.com") ? {} : undefined,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      // The cloud "web" ACL denies @dangerous by design (key-scoped least
      // privilege), which covers both INFO — the ready check — and CLIENT
      // SETINFO. ioredis proceeds identically when the check is denied, so on
      // ACL'd deployments these two would only add denied round-trips per
      // connect and a misleading NOPERM warn; a plain no-ACL Redis behaves
      // the same with them off.
      enableReadyCheck: false,
      disableClientInfo: true,
    });
  }
  return globalForRedis.onecliRedis;
};
