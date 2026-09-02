import type { Context, Env } from "hono";
import { createMiddleware } from "hono/factory";
import type { ApiEnv } from "../../types";
import { logger } from "../../lib/logger";
import { apiError } from "../../middleware/error-handler";
import { getRedis, hasRedisConfigured } from "../clients/redis-client";
import { redisKeys } from "../clients/redis-keys";

const log = logger.child({ component: "rate-limit" });

interface RateLimitOptions<E extends Env> {
  /** Key namespace, e.g. "sso-lookup" — becomes part of the Redis key. */
  name: string;
  /** Max requests per window per key. */
  limit: number;
  windowSeconds: number;
  /** Identity to count against (an org id, an IP, ...). */
  key: (c: Context<E>) => string;
}

/** Once per process: a Redis-less deploy is a configuration, not an outage. */
let unconfiguredLogged = false;

/**
 * Fixed-window Redis rate limiter: INCR then an UNCONDITIONAL EXPIRE (a
 * crash between the two must never leave an immortal key). Two degraded
 * modes, deliberately distinct: no REDIS_HOST at all is the normal self-host
 * deployment (Redis is cloud infrastructure), so the throttle is simply off —
 * one info line per process, never a per-request error. A CONFIGURED Redis
 * that errors is an outage: FAIL-OPEN and log it — these guard
 * login-adjacent and admin surfaces where availability beats throttle
 * integrity; an outage is logged, not imposed on users. Generic over the
 * Hono env so non-/v1 apps (e.g. the SCIM dialect) can key on their own
 * context vars.
 */
export const rateLimit = <E extends Env = ApiEnv>(
  options: RateLimitOptions<E>,
) =>
  createMiddleware<E>(async (c, next) => {
    if (!hasRedisConfigured()) {
      if (!unconfiguredLogged) {
        unconfiguredLogged = true;
        log.info("rate limiting disabled: no REDIS_HOST configured");
      }
      await next();
      return;
    }
    try {
      const redis = getRedis();
      const key = redisKeys.throttle(
        options.name,
        options.key(c),
        options.windowSeconds,
      );
      const count = await redis.incr(key);
      await redis.expire(key, options.windowSeconds);
      if (count > options.limit) {
        return c.json(
          apiError("Too many requests. Try again shortly.", "rate_limit_error"),
          429,
        );
      }
    } catch (err) {
      log.error({ err, name: options.name }, "rate limit unavailable");
    }
    await next();
  });

/**
 * Best-effort client IP behind the CloudFront → ALB chain. Prefer the
 * CloudFront-set viewer address (not client-forgeable; the distribution
 * already forwards CloudFront-Viewer-* headers) and fall back to the
 * leftmost x-forwarded-for hop — client-controlled in principle, which is
 * acceptable for abuse-throttling (not for auth decisions).
 */
export const clientIpKey = (c: Context<ApiEnv>): string => {
  const viewer = c.req.header("cloudfront-viewer-address");
  // "ip:port" (IPv4) or "ip:port" with a bracketless IPv6 ip — strip the port.
  if (viewer) return viewer.slice(0, viewer.lastIndexOf(":")) || viewer;
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
};
