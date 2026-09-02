import { randomUUID } from "node:crypto";
import { getRedis } from "./redis-client";
import { ServiceError } from "../../services/errors";

/**
 * Minimal distributed lock over the shared Redis. Suitable for serializing
 * rare admin operations (e.g. Cognito app-client updates) — NOT a fencing
 * lock: if the TTL expires mid-section a second holder can enter, so keep
 * sections short and use `isHeld` before irreversible external writes.
 *
 * Failure semantics: a busy lock (SET NX keeps returning null) until
 * acquireTimeout → ServiceError("CONFLICT") for the caller to surface as
 * "try again". Redis/connection errors PROPAGATE — an infra outage must
 * fail loudly, not masquerade as contention.
 */

interface RedisLockOptions {
  ttlMs?: number;
  acquireTimeoutMs?: number;
  retryDelayMs?: number;
}

// Delete the key only if it still holds our token (never release a lock a
// slower holder lost to TTL expiry). Key arrives via KEYS[1] — the Redis
// ACL scopes this user to `api:*` key patterns.
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True while this holder's token still owns the lock key. */
export const isLockHeld = async (
  key: string,
  token: string,
): Promise<boolean> => (await getRedis().get(key)) === token;

export const withRedisLock = async <T>(
  key: string,
  fn: (lock: { token: string; isHeld: () => Promise<boolean> }) => Promise<T>,
  {
    ttlMs = 60_000,
    acquireTimeoutMs = 10_000,
    retryDelayMs = 250,
  }: RedisLockOptions = {},
): Promise<T> => {
  const redis = getRedis();
  const token = randomUUID();

  const deadline = Date.now() + acquireTimeoutMs;
  for (;;) {
    const acquired = await redis.set(key, token, "PX", ttlMs, "NX");
    if (acquired === "OK") break;
    if (Date.now() + retryDelayMs > deadline) {
      throw new ServiceError(
        "CONFLICT",
        "Another SSO configuration change is in progress. Try again in a moment.",
      );
    }
    await sleep(retryDelayMs);
  }

  try {
    return await fn({ token, isHeld: () => isLockHeld(key, token) });
  } finally {
    // Best-effort release; TTL is the backstop if this fails.
    try {
      await redis.eval(RELEASE_SCRIPT, 1, key, token);
    } catch {
      // swallow: the lock self-expires
    }
  }
};
