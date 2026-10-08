/**
 * The dashboard's server-side forward of api form submits that arrive on its
 * own `/auth/<page>` paths (proxy.ts `apiFormSubmitOnPagePath`).
 *
 * Why this exists: better-auth answers `POST /auth/reset-password` while the
 * dashboard renders `GET /auth/reset-password`. Before the forward, every
 * edge in front of a self-host needed a method-aware rule to split those,
 * and an Ingress cannot express one. Now the edge sends the whole page path
 * to the dashboard and the dashboard hands the submit to the api itself.
 *
 * Onprem arm: the forward is self-host only (cloud's auth is Cognito).
 */

import { vi, describe, expect, it, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_EDITION;
  delete process.env.EDITION;
});

import { NextRequest } from "next/server";
import { proxy, WEB_AUTH_PAGES } from "./proxy";

const DASHBOARD = "https://onecli.example.test";
const API_INTERNAL = "http://onecli-api.onecli.svc:10256";

const request = (path: string, method = "GET") =>
  new NextRequest(`${DASHBOARD}${path}`, { method });

/** The destination Next will proxy to, or null when the request fell through. */
const rewrittenTo = (response: Response): string | null =>
  response.headers.get("x-middleware-rewrite");

describe("onprem: api form submits on dashboard page paths", () => {
  beforeEach(() => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret");
    vi.stubEnv("SECRET_ENCRYPTION_KEY", "test-key");
    vi.stubEnv("API_INTERNAL_URL", API_INTERNAL);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("forwards POST /auth/reset-password to the api, query intact", () => {
    const response = proxy(
      request("/auth/reset-password?token=abc%20def", "POST"),
    );
    expect(rewrittenTo(response)).toBe(
      `${API_INTERNAL}/auth/reset-password?token=abc%20def`,
    );
  });

  it("forwards every non-page-load method on every page path", () => {
    for (const page of WEB_AUTH_PAGES) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const response = proxy(request(page, method));
        expect(rewrittenTo(response), `${method} ${page}`).toBe(
          `${API_INTERNAL}${page}`,
        );
      }
    }
  });

  it("renders page loads itself (GET and HEAD are never forwarded)", () => {
    for (const page of WEB_AUTH_PAGES) {
      for (const method of ["GET", "HEAD"]) {
        const response = proxy(request(page, method));
        expect(rewrittenTo(response), `${method} ${page}`).toBeNull();
      }
    }
  });

  it("leaves page subroutes alone: they are dashboard pages too", () => {
    // `/auth/login/sso` is a page; a POST there is the dashboard's business
    // (a server function, for instance), not better-auth's.
    const response = proxy(request("/auth/login/sso", "POST"));
    expect(rewrittenTo(response)).toBeNull();
  });

  it("leaves the api's own /auth routes alone: the edge routes those directly", () => {
    // Nothing to forward: these never reach the dashboard in production, and
    // in dev the next.config rewrites carry them. Pinned so the forward can
    // never widen into a second, method-blind proxy of all of /auth.
    for (const apiPath of [
      "/auth/sign-in/email",
      "/auth/get-session",
      "/auth/reset-password/some-token",
    ]) {
      const response = proxy(request(apiPath, "POST"));
      expect(rewrittenTo(response), apiPath).toBeNull();
    }
  });

  it("drops any path on API_INTERNAL_URL: it is an origin, not a base", () => {
    vi.stubEnv("API_INTERNAL_URL", "http://onecli-api:10256/ignored/");
    const response = proxy(request("/auth/signup", "POST"));
    expect(rewrittenTo(response)).toBe("http://onecli-api:10256/auth/signup");
  });

  it("falls back to the public api origin when API_INTERNAL_URL is unset", () => {
    vi.stubEnv("API_INTERNAL_URL", "");
    vi.stubEnv("ONECLI_EXTERNAL_URL", "https://onecli.example.test");
    const response = proxy(request("/auth/reset-password", "POST"));
    // https external URL ⇒ proxy mode ⇒ the api shares the dashboard origin.
    expect(rewrittenTo(response)).toBe(
      "https://onecli.example.test/auth/reset-password",
    );
  });

  it("bypasses the setup-error redirect the way the rest of the api surface does", () => {
    // A submit is the api's to answer (it reports its own config errors to
    // a form client); a 307 to an HTML setup page is not a response one can
    // use. Page LOADS on the same path keep the gate.
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    const submit = proxy(request("/auth/reset-password", "POST"));
    expect(rewrittenTo(submit)).toBe(`${API_INTERNAL}/auth/reset-password`);

    const load = proxy(request("/auth/reset-password", "GET"));
    expect(load.status).toBe(307);
    expect(load.headers.get("location")).toContain("/setup-error");
  });

  it("carries no dashboard response headers on the forward", () => {
    const response = proxy(request("/auth/reset-password", "POST"));
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("x-middleware-request-x-nonce")).toBeNull();
  });
});
