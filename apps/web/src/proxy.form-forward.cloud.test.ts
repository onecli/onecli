/**
 * Cloud arm of proxy.form-forward.onprem.test.ts: the dashboard's forward of
 * api form submits on its `/auth/<page>` paths is self-host only. Cloud's
 * auth is Cognito; there is no better-auth endpoint behind those paths, so a
 * POST there must reach the dashboard's own handling, never a rewrite.
 */

import { vi, describe, expect, it } from "vitest";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  delete process.env.EDITION;
});

import { NextRequest } from "next/server";
import { proxy, WEB_AUTH_PAGES } from "./proxy";

describe("cloud: no form forward on dashboard page paths", () => {
  it("never rewrites a non-page-load on a page path", () => {
    vi.stubEnv("API_INTERNAL_URL", "http://onecli-api:10256");
    for (const page of WEB_AUTH_PAGES) {
      const response = proxy(
        new NextRequest(`https://app.onecli.sh${page}`, { method: "POST" }),
      );
      expect(response.headers.get("x-middleware-rewrite"), page).toBeNull();
    }
    vi.unstubAllEnvs();
  });
});
