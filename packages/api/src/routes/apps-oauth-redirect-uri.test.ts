import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../types";

/**
 * The OAuth `redirect_uri` sent to the provider — both legs of the flow.
 *
 * The redirect URI is a `/v1` URL answered by the api-server, so it must be
 * built from the **API** origin. A configured `APP_URL` names the dashboard
 * host, which serves no `/v1` — building the redirect URI from it breaks every
 * deployment that splits the two (the self-host compose does): the provider
 * either rejects the unregistered URI outright or redirects the browser into a
 * 404. These tests pin the resolution on both legs — `/authorize` building the
 * consent URL and the callback rebuilding the URI for the token exchange —
 * which no other test observes (every other registry mock ignores
 * `redirectUri`).
 *
 * Onprem-pinned in its own file: the edition is read at module load, and the
 * siblings pin their own (`apps.test.ts` onprem for Location origins,
 * `apps-callback-origin.test.ts` cloud for the split-host browser redirect).
 */

const WORKSPACE_KEY = "oc_test-workspace-key";

// Hermetic to the ambient edition (CI runs with NEXT_PUBLIC_EDITION=cloud):
// pin everything before any import evaluates (vi.hoisted runs first).
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = "test-oauth-state-secret";
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
});

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === WORKSPACE_KEY
          ? { userId: "user-1", workspaceId: "proj-1" }
          : null,
    },
    workspace: {
      findUnique: async () => ({ id: "proj-1", organizationId: "org-1" }),
      findFirst: async () => ({ id: "proj-1" }),
    },
    user: {
      findUnique: async () => ({ email: "admin@example.com" }),
    },
  },
}));

vi.mock("../services/workspace-access-check", () => ({
  canAccessWorkspaceAsUser: async () => true,
}));

// The observation point: capture the `redirectUri` each leg passes the
// provider adapter — the value under test.
const captured: { authUrl: string[]; exchange: string[] } = {
  authUrl: [],
  exchange: [],
};

vi.mock("../apps/registry", () => ({
  getApp: (id: string) =>
    id === "oauthapp"
      ? {
          id,
          name: "OAuth App",
          connectionMethod: {
            type: "oauth",
            defaultScopes: ["read"],
            buildAuthUrl: async ({ redirectUri }: { redirectUri: string }) => {
              captured.authUrl.push(redirectUri);
              return `https://provider.example/auth?redirect=${encodeURIComponent(redirectUri)}`;
            },
            exchangeCode: async ({ redirectUri }: { redirectUri: string }) => {
              captured.exchange.push(redirectUri);
              return {
                credentials: { access_token: "tok" },
                scopes: ["read"],
                metadata: { email: "acct@example.com" },
              };
            },
          },
        }
      : undefined,
  getApps: () => [],
}));

vi.mock("../apps/resolve-credentials", () => ({
  resolveAppCredentials: async () => ({
    values: { clientId: "cid", clientSecret: "cs" },
    appConfigId: "cfg-1",
  }),
}));

vi.mock("../services/connection-service", () => ({
  listConnections: async () => [],
  listConnectionsByProvider: async () => [],
  createConnection: async () => ({ id: "conn-new" }),
  reconnectConnection: async () => ({ id: "conn-old" }),
  linkConnectionToAppConfig: async () => undefined,
  extractLabel: () => undefined,
}));

vi.mock("../lib/gateway-invalidate", () => ({
  invalidateGatewayCache: () => undefined,
  invalidateGatewayCacheForAccount: () => undefined,
}));

import { createApiApp } from "../app";
import { signOAuthState, generateNonce } from "../lib/oauth-state";

const URL_VARS = [
  "APP_URL",
  "NEXT_PUBLIC_APP_URL",
  "API_URL",
  "NEXT_PUBLIC_API_URL",
] as const;

describe("oauth redirect_uri resolves to the API origin", () => {
  let app: Hono<ApiEnv>;

  beforeAll(() => {
    app = createApiApp({ getSession: async () => null });
  });

  const orig = Object.fromEntries(
    URL_VARS.map((key) => [key, process.env[key]]),
  );
  afterEach(() => {
    for (const key of URL_VARS) {
      if (orig[key] === undefined) delete process.env[key];
      else process.env[key] = orig[key];
    }
    captured.authUrl.length = 0;
    captured.exchange.length = 0;
  });

  const splitHostEnv = () => {
    // The self-host compose shape: both URLs set, on different hosts.
    process.env.APP_URL = "https://dashboard.example.com";
    process.env.NEXT_PUBLIC_APP_URL = "https://dashboard.example.com";
    process.env.API_URL = "https://api.example.com";
    delete process.env.NEXT_PUBLIC_API_URL;
  };

  const authorize = () =>
    app.request("/v1/apps/oauthapp/authorize", {
      headers: {
        authorization: `Bearer ${WORKSPACE_KEY}`,
        host: "arrived.example.com",
      },
    });

  const callback = (state: string) =>
    app.request(
      `/v1/apps/oauthapp/callback?code=abc123&state=${encodeURIComponent(state)}`,
      { headers: { host: "arrived.example.com" } },
    );

  // The reported bug: with both URLs configured, the redirect_uri went to the
  // dashboard host — an unregistered URI at the provider, and a 404 even when
  // registered, because the dashboard serves no /v1.
  it("authorize builds the redirect_uri from API_URL, never APP_URL", async () => {
    splitHostEnv();

    const res = await authorize();

    expect(res.status).toBe(302);
    expect(captured.authUrl).toEqual([
      "https://api.example.com/v1/apps/oauthapp/callback",
    ]);
  });

  it("the callback's token exchange rebuilds the identical redirect_uri", async () => {
    splitHostEnv();

    const state = signOAuthState({
      workspaceId: "proj-1",
      provider: "oauthapp",
      nonce: generateNonce(),
      origin: "https://dashboard.example.com",
    });
    const res = await callback(state);

    expect(res.status).toBe(302);
    // Success proves the exchange ran; its redirect_uri matches authorize's.
    expect(res.headers.get("location")).toContain(
      "https://dashboard.example.com/app-connect/oauthapp?status=success",
    );
    expect(captured.exchange).toEqual([
      "https://api.example.com/v1/apps/oauthapp/callback",
    ]);
  });

  it("derives the redirect_uri from the request when no API URL is configured", async () => {
    for (const key of URL_VARS) delete process.env[key];

    const res = await authorize();

    expect(res.status).toBe(302);
    expect(captured.authUrl).toEqual([
      "http://arrived.example.com/v1/apps/oauthapp/callback",
    ]);
  });

  // Route-level pins for the canonical var: the redirect_uri must follow the
  // resolver's derivation — ports mode pins the api port on the external
  // host; proxy mode pins the single https origin. These existed only at the
  // facade level before; the route is what providers actually see.
  it("ONECLI_EXTERNAL_URL (http) derives the redirect_uri on the api port", async () => {
    for (const key of URL_VARS) delete process.env[key];
    process.env.ONECLI_EXTERNAL_URL = "http://192.0.2.10:10254";
    try {
      const res = await authorize();
      expect(res.status).toBe(302);
      expect(captured.authUrl).toEqual([
        "http://192.0.2.10:10256/v1/apps/oauthapp/callback",
      ]);
    } finally {
      delete process.env.ONECLI_EXTERNAL_URL;
    }
  });

  it("ONECLI_EXTERNAL_URL (https) pins the single proxy-mode origin", async () => {
    for (const key of URL_VARS) delete process.env[key];
    process.env.ONECLI_EXTERNAL_URL = "https://onecli.example.test";
    try {
      const res = await authorize();
      expect(res.status).toBe(302);
      expect(captured.authUrl).toEqual([
        "https://onecli.example.test/v1/apps/oauthapp/callback",
      ]);
    } finally {
      delete process.env.ONECLI_EXTERNAL_URL;
    }
  });

  // The zero-config landing pin: the dashboard-initiated authorize (referer
  // = the dashboard's localhost origin, trusted by default) must sign the
  // DASHBOARD origin, so the post-connect browser lands on the dashboard,
  // never on this api-server's JSON 404.
  it("unconfigured: signs the dashboard's trusted referer as the landing origin", async () => {
    for (const key of URL_VARS) delete process.env[key];

    const res = await app.request("/v1/apps/oauthapp/authorize", {
      headers: {
        authorization: `Bearer ${WORKSPACE_KEY}`,
        host: "localhost:10256",
        referer: "http://localhost:10254/w/proj-1/connections",
      },
    });
    expect(res.status).toBe(302);

    // Round-trip through the callback with the state the route actually
    // signed (the mocked provider drops it from its URL; the oauth_state
    // cookie carries it verbatim): the browser must land on :10254.
    const stateCookie = res.headers.get("set-cookie") ?? "";
    const state = decodeURIComponent(
      /oauth_state=([^;]+)/.exec(stateCookie)![1]!,
    );
    const cb = await app.request(
      `/v1/apps/oauthapp/callback?code=abc123&state=${encodeURIComponent(state)}`,
      { headers: { host: "localhost:10256" } },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toContain(
      "http://localhost:10254/app-connect/oauthapp?status=success",
    );
  });
});
