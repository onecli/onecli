import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiEnv } from "../../types";

const state = vi.hoisted(() => ({
  counts: new Map<string, number>(),
  expires: [] as Array<{ key: string; seconds: number }>,
  redisDown: false,
  configured: true,
}));

// Spy on the log, don't spray it: the error-vs-info split IS the contract
// here (outage → error + fail-open; unconfigured → one info, ever).
const logSpies = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  child: (): unknown => logSpies,
}));
vi.mock("../../lib/logger", () => ({ logger: logSpies }));

vi.mock("../clients/redis-client", () => ({
  hasRedisConfigured: () => state.configured,
  getRedis: () => ({
    incr: async (key: string) => {
      if (state.redisDown) throw new Error("connect ECONNREFUSED");
      const next = (state.counts.get(key) ?? 0) + 1;
      state.counts.set(key, next);
      return next;
    },
    expire: async (key: string, seconds: number) => {
      state.expires.push({ key, seconds });
      return 1;
    },
  }),
}));

import { clientIpKey, rateLimit } from "./rate-limit";

const buildApp = (limit: number) => {
  const app = new Hono<ApiEnv>();
  app.post(
    "/x",
    rateLimit({ name: "test", limit, windowSeconds: 60, key: clientIpKey }),
    (c) => c.json({ ok: true }),
  );
  return app;
};

beforeEach(() => {
  state.counts = new Map();
  state.expires = [];
  state.redisDown = false;
  state.configured = true;
  logSpies.error.mockClear();
  logSpies.info.mockClear();
});

describe("rateLimit", () => {
  it("passes under the limit and sets an expiry on every hit", async () => {
    const app = buildApp(2);
    const res1 = await app.request("/x", { method: "POST" });
    const res2 = await app.request("/x", { method: "POST" });
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(state.expires).toHaveLength(2);
    expect(state.expires[0]?.seconds).toBe(60);
  });

  it("returns the 429 envelope over the limit", async () => {
    const app = buildApp(1);
    await app.request("/x", { method: "POST" });
    const res = await app.request("/x", { method: "POST" });
    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("rate_limit_error");
  });

  it("keys by the first x-forwarded-for hop", async () => {
    const app = buildApp(1);
    const asIp = (ip: string) =>
      app.request("/x", {
        method: "POST",
        headers: { "x-forwarded-for": `${ip}, 10.0.0.1` },
      });
    expect((await asIp("1.1.1.1")).status).toBe(200);
    expect((await asIp("2.2.2.2")).status).toBe(200);
    expect((await asIp("1.1.1.1")).status).toBe(429);
  });

  it("fails open when a configured Redis errors — and logs the outage", async () => {
    state.redisDown = true;
    const app = buildApp(1);
    const res1 = await app.request("/x", { method: "POST" });
    const res2 = await app.request("/x", { method: "POST" });
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(logSpies.error).toHaveBeenCalledTimes(2);
  });

  it("skips the throttle entirely when Redis is not configured", async () => {
    // The normal self-host deployment: no REDIS_HOST, no throttle — no Redis
    // calls at all, one info line ever, and never a per-request error.
    state.configured = false;
    const app = buildApp(1);
    const res1 = await app.request("/x", { method: "POST" });
    const res2 = await app.request("/x", { method: "POST" });
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(state.counts.size).toBe(0);
    expect(state.expires).toHaveLength(0);
    expect(logSpies.error).not.toHaveBeenCalled();
    expect(logSpies.info).toHaveBeenCalledTimes(1);
  });
});
