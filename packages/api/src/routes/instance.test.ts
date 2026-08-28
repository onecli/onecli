import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The §3.13 auto-hide proof, route level (step 13): `GET /v1/instance` is the
 * ONE place the browser learns whether hosted agents exist here, so the
 * route's contract — unauthenticated, `runners` always present, exactly two
 * booleans, truthfully derived from the Runner table — IS the merge gate's
 * API half. The web half (the sidebar rendering each posture) lives in
 * apps/web/src/lib/dashboard/dashboard-sidebar.test.tsx.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  delete process.env.ENTERPRISE_ENABLED;
});

const store = vi.hoisted(() => ({
  total: 0,
  online: 0,
  // Capabilities of the online runner findFirst returns. `{}` fails the
  // schema parse → homeDurability omitted (the pre-step-3 two-boolean shape).
  onlineCaps: {} as unknown,
}));

vi.mock("@onecli/db", () => ({
  db: {
    runner: {
      // registered = any runner exists.
      count: async () => store.total,
      // online = the oldest runner within the liveness window, or null; its
      // capabilities carry the declared home-durability class (step 3).
      findFirst: async () =>
        store.online > 0 ? { capabilities: store.onlineCaps } : null,
    },
  },
}));

const { createApiApp } = await import("../app");
const { initEntitlementForTests } = await import("../lib/entitlements");
const { resetRunnerAvailabilityCache } =
  await import("../services/runner-service");

const app = createApiApp({ getSession: async () => null });

beforeEach(() => {
  store.total = 0;
  store.online = 0;
  store.onlineCaps = {};
  // The 5s availability cache would otherwise leak one case into the next.
  resetRunnerAvailabilityCache();
});

describe("GET /v1/instance (the auto-hide fact)", () => {
  it("answers unauthenticated — posture, never data", async () => {
    const res = await app.request("/v1/instance");
    expect(res.status).toBe(200);
  });

  it("a deployment that never had a runner: registered:false, online:false", async () => {
    const res = await app.request("/v1/instance");
    const body = (await res.json()) as { runners: unknown };
    expect(body.runners).toEqual({ registered: false, online: false });
  });

  it("a registered-but-stale runner reads offline, never absent", async () => {
    store.total = 1;
    store.online = 0;
    const res = await app.request("/v1/instance");
    const body = (await res.json()) as { runners: unknown };
    expect(body.runners).toEqual({ registered: true, online: false });
  });

  it("a fresh heartbeat reads ready", async () => {
    store.total = 1;
    store.online = 1;
    const res = await app.request("/v1/instance");
    const body = (await res.json()) as { runners: unknown };
    expect(body.runners).toEqual({ registered: true, online: true });
  });

  it("entitled flips with the license flag — the ONE fact the browser gates on", async () => {
    initEntitlementForTests(false);
    const off = (await (await app.request("/v1/instance")).json()) as {
      entitled: boolean;
    };
    expect(off.entitled).toBe(false);

    initEntitlementForTests(true);
    const on = (await (await app.request("/v1/instance")).json()) as {
      entitled: boolean;
    };
    expect(on.entitled).toBe(true);

    initEntitlementForTests(null);
  });

  it("surfaces the online runner's home-durability class when it advertises one (§3.9)", async () => {
    store.total = 1;
    store.online = 1;
    store.onlineCaps = {
      maxSandboxes: 4,
      backend: "cloud",
      homeDurability: "snapshot",
    };
    const res = await app.request("/v1/instance");
    const body = (await res.json()) as { runners: Record<string, unknown> };
    expect(body.runners).toEqual({
      registered: true,
      online: true,
      homeDurability: "snapshot",
    });
  });

  it("omits home-durability when the online runner's capabilities don't declare one", async () => {
    store.total = 1;
    store.online = 1;
    store.onlineCaps = {}; // unparseable → absence, never a fabricated default
    const res = await app.request("/v1/instance");
    const body = (await res.json()) as { runners: Record<string, unknown> };
    expect(body.runners).toEqual({ registered: true, online: true });
  });

  it("carries exactly the posture surface: edition, entitlement, version, origins, runner booleans", async () => {
    const res = await app.request("/v1/instance");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "edition",
      "entitled",
      "origins",
      "runners",
      "version",
    ]);
    // Two booleans, no runner identity, no counts — the posture-not-data rule.
    expect(Object.keys(body.runners as object).sort()).toEqual([
      "online",
      "registered",
    ]);
    expect(body.edition).toBe("onprem");
    expect(typeof body.entitled).toBe("boolean");
  });

  it("exposes the resolved public origins — advertised addresses only", async () => {
    // Hermetic setup deletes every URL var before this file loads, so the
    // resolver answers its localhost defaults here — the same values the
    // layout injects into every page, never an internal address.
    const res = await app.request("/v1/instance");
    const body = (await res.json()) as { origins: Record<string, unknown> };
    expect(body.origins).toEqual({
      external: "http://localhost:10254",
      api: "http://localhost:10256",
      gateway: "http://localhost:10255",
      mode: "ports",
    });
  });
});
