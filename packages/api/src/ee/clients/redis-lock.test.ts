import { beforeEach, describe, expect, it, vi } from "vitest";

const redisState = vi.hoisted(() => ({
  store: new Map<string, string>(),
  setCalls: 0,
  failSet: false,
  evalCalls: [] as { keys: string[]; args: string[] }[],
}));

vi.mock("./redis-client", () => ({
  getRedis: () => ({
    set: async (key: string, value: string, ...rest: (string | number)[]) => {
      void rest; // PX/ttl/NX flags — irrelevant to the fake

      redisState.setCalls += 1;
      if (redisState.failSet) throw new Error("ECONNREFUSED");
      if (redisState.store.has(key)) return null;
      redisState.store.set(key, value);
      return "OK";
    },
    get: async (key: string) => redisState.store.get(key) ?? null,
    eval: async (
      _script: string,
      _numKeys: number,
      key: string,
      token: string,
    ) => {
      redisState.evalCalls.push({ keys: [key], args: [token] });
      if (redisState.store.get(key) === token) {
        redisState.store.delete(key);
        return 1;
      }
      return 0;
    },
  }),
}));

import { withRedisLock, isLockHeld } from "./redis-lock";
import { ServiceError } from "../../services/errors";

beforeEach(() => {
  redisState.store.clear();
  redisState.setCalls = 0;
  redisState.failSet = false;
  redisState.evalCalls = [];
});

describe("withRedisLock", () => {
  it("acquires, runs, and releases", async () => {
    const result = await withRedisLock("api:lock:test", async () => "done");
    expect(result).toBe("done");
    expect(redisState.store.has("api:lock:test")).toBe(false);
    expect(redisState.evalCalls).toHaveLength(1);
  });

  it("retries while busy and acquires when freed", async () => {
    redisState.store.set("api:lock:test", "other-holder");
    setTimeout(() => redisState.store.delete("api:lock:test"), 100);
    const result = await withRedisLock("api:lock:test", async () => 42, {
      retryDelayMs: 30,
      acquireTimeoutMs: 2_000,
    });
    expect(result).toBe(42);
    expect(redisState.setCalls).toBeGreaterThan(1);
  });

  it("times out on a held lock with CONFLICT", async () => {
    redisState.store.set("api:lock:test", "other-holder");
    await expect(
      withRedisLock("api:lock:test", async () => "never", {
        retryDelayMs: 20,
        acquireTimeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("propagates Redis errors instead of CONFLICT", async () => {
    redisState.failSet = true;
    await expect(
      withRedisLock("api:lock:test", async () => "never"),
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("releases only its own token", async () => {
    await withRedisLock("api:lock:test", async ({ token }) => {
      // Simulate TTL expiry + takeover by another holder mid-section.
      redisState.store.set("api:lock:test", "other-holder");
      expect(await isLockHeld("api:lock:test", token)).toBe(false);
    });
    // Release ran but must NOT have deleted the other holder's lock.
    expect(redisState.store.get("api:lock:test")).toBe("other-holder");
  });

  it("releases the lock when fn throws", async () => {
    await expect(
      withRedisLock("api:lock:test", async () => {
        throw new ServiceError("BAD_REQUEST", "boom");
      }),
    ).rejects.toThrow("boom");
    expect(redisState.store.has("api:lock:test")).toBe(false);
  });

  it("reports isHeld true while holding", async () => {
    await withRedisLock("api:lock:test", async ({ isHeld }) => {
      expect(await isHeld()).toBe(true);
    });
  });
});
