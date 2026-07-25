import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../types";

/**
 * The OAuth callback's redirect origin when the API and the dashboard are
 * served on **different hosts**.
 *
 * A deployment can run this API package standalone — answering on an API host
 * and declaring it via the `selfUrl` option — while the dashboard pages are
 * served elsewhere. CLI and SDK clients talk to the API host, so a browser can
 * arrive at this callback there; but `/app-connect/*` is a Next.js page that
 * only exists on the dashboard host. The last redirect therefore has to cross
 * origins, which it can only do from a configured `APP_URL`.
 *
 * This lives in its own file because the edition (and so `IS_CLOUD`) is read at
 * module load, and the sibling `apps.test.ts` pins `onprem-slim` for the
 * single-host cases. Nothing here is mocked — the real resolution path runs,
 * which is what makes it a trustworthy guard.
 */

const API_ORIGIN = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";

// Literals, not the consts above: vi.hoisted runs before they initialize.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  process.env.SECRET_ENCRYPTION_KEY = "test-oauth-state-secret";
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
  // A split-host deployment sets APP_URL on every process — always the
  // dashboard host, never the API host.
  process.env.APP_URL = "https://app.example.com";
});

vi.mock("@onecli/db", () => ({ Prisma: {}, db: {} }));

vi.mock("../apps/registry", () => ({
  getApp: () => undefined,
  getApps: () => [],
}));

import { createApiApp } from "../app";

describe("oauth callback redirect origin (split API/dashboard hosts)", () => {
  let app: Hono<ApiEnv>;

  beforeAll(() => {
    // A standalone host declares its own address via `selfUrl`, so
    // getRequestOrigin() resolves to the API origin here.
    app = createApiApp(
      { getSession: async () => null },
      { selfUrl: API_ORIGIN },
    );
  });

  // The guard against "just use the request origin". That would send the
  // browser to the API host, where /app-connect/* does not exist, turning every
  // CLI-initiated connect into a 404 on the last hop.
  it("sends the browser to the dashboard host, not the API host it arrived on", async () => {
    const res = await app.request("/v1/apps/nosuchprovider/callback", {
      headers: { host: "api.example.com" },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `${APP_ORIGIN}/app-connect/nosuchprovider?status=error&message=Invalid%20provider`,
    );
    expect(res.headers.get("location")).not.toContain(API_ORIGIN);
  });
});
