import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── The EE mount walk: every route registerEeRoutes mounts must be DARK on an
// unlicensed self-host — answered by a RECOGNIZED gate, not by whatever
// middleware happens to sit behind it.
//
// This closes the structural blind spot enterprise-lock.test.ts cannot see:
// its completeness walks the ENTERPRISE_FEATURES registry, so an ee/ router
// mounted with no feature key (the webhooks/reviewer bug class) ships ungated
// without failing anything. Here the walk enumerates the MOUNTS themselves:
// a new keyless router fails until it is gated or explicitly declared below.
//
// The EE mount set is DERIVED, not listed: two real apps are built — one with
// EE routes, one with `eeRoutes: () => {}` — and the difference is exactly
// what registerEeRoutes added. Probing the REAL app (not a bare Hono) is
// load-bearing: the app's error handler is what turns a thrown ServiceError
// into its status, so a bare router would report 500s that production never
// returns.
//
// Recognized gates, and nothing else:
//   • 403 error.type "enterprise_license_required" (requireEnterprise)
//   • 404 error.type "invalid_request_error"       (edition-dark: CAPS/IS_CLOUD)
//   • 410 (a deliberate tombstone for a removed surface)
//   • an EXPECTED_OPEN entry pinning path, method, status, and the reason
// A 401 is NOT a gate — "behind auth" was exactly the reviewer-bug shape: the
// surface stays reachable to any signed-in self-host user.
//
// Onprem lane only: unlicensed cloud is not a real state (parseEntitled
// forces cloud entitled), and the edition-dark gates deliberately stand open
// there.

vi.hoisted(() => {
  process.env.SECRET_ENCRYPTION_KEY ??= "test-secret";
  process.env.OAUTH_STATE_SECRET ??= "test-secret";
});

// Nothing here should reach a query — the gates answer first. A recording
// proxy makes any query that DOES happen visible instead of crashing the
// walk on an undefined model.
const dbCalls = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock("@onecli/db", () => {
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => async () => {
          dbCalls.names.push(`${name}.${method}`);
          return null;
        },
      },
    );
  return {
    Prisma: {},
    db: new Proxy({}, { get: (_t, name: string) => model(name) }),
  };
});

import { createApiApp } from "../app";
import { initEntitlementForTests } from "../lib/entitlements";
import { EDITION_INFO } from "../lib/env";

const onpremLane = EDITION_INFO.edition === "onprem";

const LICENSE_TYPE = "enterprise_license_required";
const EDITION_DARK_TYPE = "invalid_request_error";
/** A deliberate answer for a removed surface, not a leak. */
const GONE = 410;

/**
 * Deliberately non-license-gated mounts, each pinned to its exact refusal so
 * a gate swap (or a silently weakened one) fails the walk until re-declared.
 */
const EXPECTED_OPEN: {
  method: string;
  path: string;
  status: number;
  reason: string;
}[] = [
  // Deliberately EMPTY. Every mount now answers a recognized gate on its own:
  // the licensed routers 403, the hosted-platform ones (Resend/Stripe intake,
  // reviewer ops) are edition-dark 404s, and the removed surfaces are 410
  // tombstones. Their in-cloud config-darkness (a missing signing secret) is
  // proven where it belongs — ee/routes/{webhooks,stripe-webhooks}.test.ts.
  // An entry here is an admission that something is reachable; keep it empty
  // unless there is a reason that survives review.
];

/**
 * Concrete probe paths. `:param` segments get a value, and `*` becomes a real
 * segment — wildcard routes are REAL handlers (the removed-surface tombstones
 * are `app.all("/*")`), so skipping them would leave the very shape this lock
 * exists to catch unprobed.
 */
const probePath = (path: string) =>
  path
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) return "test-1";
      return seg.replace(/\*/g, "probe");
    })
    .join("/");

const routeKeys = (app: { routes: { method: string; path: string }[] }) =>
  new Set(app.routes.map((r) => `${r.method} ${r.path}`));

describe.skipIf(!onpremLane)(
  "the EE mount walk (unlicensed self-host surface is dark)",
  () => {
    beforeEach(() => {
      initEntitlementForTests(false);
      dbCalls.names = [];
    });
    afterEach(() => initEntitlementForTests(null));

    it("every route registerEeRoutes mounts answers a recognized gate or is declared open", async () => {
      const session = { getSession: async () => null };
      const withEe = createApiApp(session);
      // The same app with EE routes suppressed — the difference IS the EE
      // mount set, so nothing has to be hand-listed and a new mount is
      // picked up automatically.
      const withoutEe = createApiApp(session, { eeRoutes: () => {} });
      const shared = routeKeys(withoutEe);

      const eeRoutes = [
        ...new Map(
          withEe.routes
            .filter((r) => !shared.has(`${r.method} ${r.path}`))
            .map((r) => [
              `${r.method} ${r.path}`,
              // `app.use` middleware registers as ALL; probe it as a GET.
              { method: r.method === "ALL" ? "GET" : r.method, path: r.path },
            ]),
        ).values(),
      ];

      // Anti-vacuous: the EE surface is large; an empty or tiny walk means
      // the derivation broke, not that the surface is safe.
      expect(eeRoutes.length).toBeGreaterThan(20);

      const declaredOpen = new Map(
        EXPECTED_OPEN.map((e) => [`${e.method} ${e.path}`, e]),
      );
      const failures: string[] = [];
      const seenOpen = new Set<string>();

      for (const { method, path } of eeRoutes) {
        const probe = probePath(path);
        const res = await withEe.request(probe, { method });
        const key = `${method} ${path}`;

        // DIFFERENTIAL: some entries are `app.use` middleware whose path a
        // SHARED router owns (`/v1/workspaces/*` is the shared workspace
        // CRUD's), and Hono answers with the first match. When both apps
        // answer identically the EE mount decides nothing at that path, so
        // there is no EE surface to gate — while an ungated EE handler
        // always differs from the no-EE app's 404.
        const bare = await withoutEe.request(probe, { method });
        if (bare.status === res.status && !declaredOpen.has(key)) continue;

        const expected = declaredOpen.get(key);

        if (expected) {
          seenOpen.add(key);
          if (res.status !== expected.status) {
            failures.push(
              `${key}: declared open with ${expected.status} (${expected.reason}) but answered ${res.status}`,
            );
          }
          continue;
        }

        if (res.status === GONE) continue;

        const body = (await res.json().catch(() => null)) as {
          error?: { type?: string };
        } | null;
        const licenseGated =
          res.status === 403 && body?.error?.type === LICENSE_TYPE;
        const editionDark =
          res.status === 404 && body?.error?.type === EDITION_DARK_TYPE;
        if (!licenseGated && !editionDark) {
          failures.push(
            `${key}: answered ${res.status} — not a recognized gate. Gate it (requireEnterprise / edition-dark 404) or declare it in EXPECTED_OPEN with its reason.`,
          );
        }
      }

      // Stale declarations are lies about the surface — prune them.
      for (const key of declaredOpen.keys()) {
        if (!seenOpen.has(key)) {
          failures.push(`EXPECTED_OPEN entry no longer mounted: ${key}`);
        }
      }

      expect(failures, failures.join("\n")).toEqual([]);
    });
  },
);
