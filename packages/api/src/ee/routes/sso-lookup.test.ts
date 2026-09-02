import { Hono } from "hono";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
  beforeAll,
  afterAll,
} from "vitest";
import { initEntitlementForTests } from "../../lib/entitlements";
import type { ApiEnv } from "../../types";

const state = vi.hoisted(() => ({
  lookup: null as { provider: string; enforced?: boolean } | null,
  lookupCalls: [] as string[],
  counts: new Map<string, number>(),
}));

vi.mock("../sso/sso-trust", () => ({
  lookupSsoForEmail: async (email: string) => {
    state.lookupCalls.push(email);
    return state.lookup;
  },
}));

vi.mock("../clients/redis-client", () => ({
  hasRedisConfigured: () => true,
  getRedis: () => ({
    incr: async (key: string) => {
      const next = (state.counts.get(key) ?? 0) + 1;
      state.counts.set(key, next);
      return next;
    },
    expire: async () => 1,
  }),
}));

import { ssoLookupRoutes } from "./sso-lookup";

const app = new Hono<ApiEnv>().route("/auth/sso", ssoLookupRoutes());

const post = (body: unknown, ip = "1.1.1.1") =>
  app.request("/auth/sso/lookup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  state.lookup = null;
  state.lookupCalls = [];
  state.counts = new Map();
});

// This suite exercises licensed features — run it entitled. The unlicensed
// refusal of each feature is proven in licensing/enterprise-lock.test.ts.
beforeAll(() => initEntitlementForTests(true));
afterAll(() => initEntitlementForTests(null));

describe("POST /auth/sso/lookup", () => {
  it("returns the provider for an SSO domain", async () => {
    state.lookup = { provider: "org-0f9b2c4d6e8a0b1c2d3e4f5a" };
    const res = await post({ email: "Guy@ACME.com " });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      sso: true,
      provider: "org-0f9b2c4d6e8a0b1c2d3e4f5a",
    });
    // zod normalized before the service saw it
    expect(state.lookupCalls).toEqual(["guy@acme.com"]);
  });

  it("returns the identical negative shape for any non-SSO email", async () => {
    const res = await post({ email: "someone@gmail.com" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ sso: false });
  });

  it("carries the enforced flag for require-SSO orgs", async () => {
    state.lookup = {
      provider: "org-0f9b2c4d6e8a0b1c2d3e4f5a",
      enforced: true,
    };
    const res = await post({ email: "guy@acme.com" });
    await expect(res.json()).resolves.toEqual({
      sso: true,
      provider: "org-0f9b2c4d6e8a0b1c2d3e4f5a",
      enforced: true,
    });
  });

  it("rejects malformed bodies with 400", async () => {
    expect((await post({ email: "not-an-email" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    const raw = await app.request("/auth/sso/lookup", {
      method: "POST",
      headers: { "x-forwarded-for": "1.1.1.1" },
      body: "not json",
    });
    expect(raw.status).toBe(400);
  });

  it("throttles per IP with the 429 envelope", async () => {
    let last: Response | null = null;
    for (let i = 0; i < 21; i++) {
      last = await post({ email: "guy@acme.com" }, "9.9.9.9");
    }
    expect(last?.status).toBe(429);
    // A different IP is unaffected.
    expect((await post({ email: "guy@acme.com" }, "8.8.8.8")).status).toBe(200);
  });
});
