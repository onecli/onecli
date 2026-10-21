/**
 * Onprem arm of proxy.csp.cloud.test.ts: the nonce CSP is cloud-only, so a
 * self-hosted page load carries no CSP, and a client-supplied x-nonce is
 * still stripped rather than forwarded to the layout.
 */

import { vi, describe, expect, it } from "vitest";

// A configured deployment, set before `@/lib/env` freezes its module-load
// reads: without these the setup gate answers every page load with a
// redirect, and the header assertions below would hold vacuously.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  delete process.env.EDITION;
  process.env.BETTER_AUTH_SECRET = "test-secret";
  process.env.SECRET_ENCRYPTION_KEY = "test-key";
});

import { NextRequest } from "next/server";
import { proxy } from "./proxy";

describe("onprem: no nonce CSP", () => {
  it("serves a page load CSP-free and never forwards a client x-nonce", () => {
    const response = proxy(
      new NextRequest("http://localhost:10254/w/ws-1/overview", {
        headers: { "x-nonce": "attacker" },
      }),
    );
    // The page load went through to the app (not a setup redirect), so the
    // forwarded request headers below are real.
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(
      response.headers.get("x-middleware-request-content-security-policy"),
    ).toBeNull();
    expect(response.headers.get("x-middleware-request-x-nonce")).toBeNull();
  });
});
