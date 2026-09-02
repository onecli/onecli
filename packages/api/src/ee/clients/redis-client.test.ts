import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pins the client options that keep the factory compatible with the cloud
 * "web" ACL (key-scoped, -@dangerous): the ready check's INFO and the
 * connect-time CLIENT SETINFO are both denied there, so they MUST stay off —
 * re-enabling either brings back a NOPERM warn and wasted denied round-trips
 * on every fresh connect. lazyConnect is what makes this test network-free:
 * construction never dials.
 */

beforeEach(() => {
  vi.resetModules();
  (globalThis as { onecliRedis?: unknown }).onecliRedis = undefined;
});

const loadWithHost = async (host: string) => {
  vi.doMock("../../lib/env", () => ({
    REDIS_HOST: host,
    REDIS_PORT: "6379",
    REDIS_USERNAME: "web",
    REDIS_PASSWORD: "pw",
  }));
  return import("./redis-client");
};

describe("getRedis client options", () => {
  it("disables the ready check and client-info handshake", async () => {
    const { getRedis } = await loadWithHost("redis.internal");
    const client = getRedis();

    expect(client.options.enableReadyCheck).toBe(false);
    expect(client.options.disableClientInfo).toBe(true);
    expect(client.options.lazyConnect).toBe(true);
  });

  it("enables TLS only for ElastiCache endpoints", async () => {
    const { getRedis } = await loadWithHost(
      "example.abc.use1.cache.amazonaws.com",
    );
    expect(getRedis().options.tls).toBeDefined();
  });

  it("throws without a configured host", async () => {
    const { getRedis, hasRedisConfigured } = await loadWithHost("");
    expect(hasRedisConfigured()).toBe(false);
    expect(() => getRedis()).toThrow("REDIS_HOST is not configured");
  });
});
