import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../types";

/**
 * The OAuth callback is **unauthenticated** — anyone can call it with whatever
 * headers they like. `/authorize` is not, and it signs the state. These tests
 * pin the consequence: once a state verifies, the post-consent destination comes
 * from what `/authorize` committed to, not from the callback's own headers.
 *
 * Driven through the real Hono app and the real `signOAuthState`, so the
 * signature path under test is genuinely exercised rather than stubbed.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = "test-oauth-state-secret";
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
});

vi.mock("@onecli/db", () => ({ Prisma: {}, db: {} }));

// One OAuth provider, no fragmentCallback — enough to walk the callback down to
// the state check without touching the database.
vi.mock("../apps/registry", () => ({
  getApp: (id: string) =>
    id === "signedapp"
      ? { id, name: id, connectionMethod: { type: "oauth" } }
      : // A fragment-callback provider (Trello-shaped): the token comes back in
        // the URL fragment, so the first hit has no token query param and the
        // handler answers with the fragment-bridge page instead of redirecting.
        id === "fragmentapp"
        ? {
            id,
            name: id,
            connectionMethod: {
              type: "oauth",
              fragmentCallback: { paramName: "token" },
            },
          }
        : undefined,
  getApps: () => [],
}));

import { createApiApp } from "../app";
import { signOAuthState, generateNonce } from "../lib/oauth-state";

const SIGNED_ORIGIN = "https://signed.example.com";
const FORGED_HOST = "forged.example.com";

// No workspaceId, so the handler stops at "Missing workspace in state" — the first
// redirect *after* the origin is re-resolved from the verified state, which is
// exactly the branch under test. Keeps the test off the database entirely.
const stateWithout = (extra: Record<string, unknown> = {}) =>
  signOAuthState({ provider: "signedapp", nonce: generateNonce(), ...extra });

const MISSING_WORKSPACE =
  "/app-connect/signedapp?status=error&message=Missing%20workspace%20in%20state";

describe("oauth callback origin comes from the signed state", () => {
  let app: Hono<ApiEnv>;

  beforeAll(() => {
    app = createApiApp({ getSession: async () => null });
  });

  const orig = process.env.APP_URL;
  afterEach(() => {
    if (orig === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = orig;
  });

  const callback = (state: string, headers: Record<string, string> = {}) =>
    app.request(
      `/v1/apps/signedapp/callback?state=${encodeURIComponent(state)}`,
      {
        headers: { host: "api.example.com", ...headers },
      },
    );

  // The security property. Without the change the forged header wins, because
  // the destination is re-derived from the request that carries it.
  it("ignores a forged X-Forwarded-Host when the state carries an origin", async () => {
    delete process.env.APP_URL;

    const res = await callback(stateWithout({ origin: SIGNED_ORIGIN }), {
      "x-forwarded-host": FORGED_HOST,
      "x-forwarded-proto": "https",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `${SIGNED_ORIGIN}${MISSING_WORKSPACE}`,
    );
    expect(res.headers.get("location")).not.toContain(FORGED_HOST);
  });

  // Guards PR #713 from the other side: a signed origin must not become a way to
  // override the one setting that makes split API/dashboard host deploys work.
  it("still lets a configured APP_URL win over the signed origin", async () => {
    process.env.APP_URL = "https://configured.example.com";

    const res = await callback(stateWithout({ origin: SIGNED_ORIGIN }));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `https://configured.example.com${MISSING_WORKSPACE}`,
    );
  });

  // A state minted before this field existed is still in flight during a deploy.
  it("falls back to the request origin when the state has no origin", async () => {
    delete process.env.APP_URL;

    const res = await callback(stateWithout(), {
      "x-forwarded-host": "proxy.example.com",
      "x-forwarded-proto": "https",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `https://proxy.example.com${MISSING_WORKSPACE}`,
    );
  });

  // Defence in depth: we signed it, so this should never happen — but if it
  // does, drop it rather than emit a redirect that goes nowhere.
  it("ignores a signed origin that is not a usable origin", async () => {
    delete process.env.APP_URL;

    const res = await callback(
      stateWithout({ origin: "javascript:alert(1)" }),
      { "x-forwarded-host": "proxy.example.com", "x-forwarded-proto": "https" },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `https://proxy.example.com${MISSING_WORKSPACE}`,
    );
  });

  // The fragment-bridge page embeds this origin inside a <script> block
  // (JSON.stringify does not neutralize "</script>"), so it is the worst place
  // to trust a header. The state reaches it via the `oauth_state` cookie that
  // /authorize set on this exact path, which is why it can be trusted at all.
  it("uses the signed origin on the fragment-bridge page, taking the state from the cookie", async () => {
    delete process.env.APP_URL;

    const state = signOAuthState({
      provider: "fragmentapp",
      nonce: generateNonce(),
      origin: SIGNED_ORIGIN,
    });

    const res = await app.request("/v1/apps/fragmentapp/callback", {
      headers: {
        host: "api.example.com",
        "x-forwarded-host": FORGED_HOST,
        "x-forwarded-proto": "https",
        cookie: `oauth_state=${state}`,
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`${SIGNED_ORIGIN}/app-connect/fragmentapp`);
    expect(html).not.toContain(FORGED_HOST);
  });

  // A state for a different provider is about to be rejected as invalid, so it
  // must not get to pick the destination on the way out.
  it("ignores an origin signed for a different provider", async () => {
    delete process.env.APP_URL;

    const otherProvider = signOAuthState({
      provider: "fragmentapp",
      nonce: generateNonce(),
      origin: SIGNED_ORIGIN,
    });

    const res = await callback(otherProvider, {
      "x-forwarded-host": "proxy.example.com",
      "x-forwarded-proto": "https",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://proxy.example.com/app-connect/signedapp?status=error&message=Invalid%20state%20parameter",
    );
    expect(res.headers.get("location")).not.toContain(SIGNED_ORIGIN);
  });

  // The paths above the state check have nothing verified to read yet, so they
  // must keep using the request-derived origin.
  it("uses the request origin for errors raised before the state is checked", async () => {
    delete process.env.APP_URL;

    const res = await app.request("/v1/apps/signedapp/callback", {
      headers: { host: "api.example.com" },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "http://api.example.com/app-connect/signedapp?status=error&message=Missing%20state%20parameter",
    );
  });
});
