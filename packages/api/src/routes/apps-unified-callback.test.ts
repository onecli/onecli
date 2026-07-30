import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../types";

/**
 * The unified OAuth callback (#301): one redirect URI — `/v1/apps/callback` —
 * shared by every provider, with the provider recovered from the HMAC-signed
 * state instead of the path.
 *
 * The rollout contract under test: `/authorize` sends the unified URI ONLY for
 * AppConfig rows stamped `redirectStyle: "unified"` at save time. Everything
 * else — older rows, env credentials — keeps the per-provider URI its OAuth
 * app already has registered. Both callbacks must hand the token exchange the
 * exact URI their flow's authorization request used, or the exchange fails at
 * the provider.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem-slim";
  process.env.SECRET_ENCRYPTION_KEY = "test-oauth-state-secret";
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
});

// Captures for the provider hooks the routes call — filled by the registry
// mock below, asserted on by the tests.
const captured = vi.hoisted(() => ({
  authUrl: [] as Array<{ redirectUri: string; state: string }>,
  exchange: [] as Array<{
    redirectUri: string;
    callbackParams: Record<string, string>;
  }>,
}));

const PROJECT_KEY = "oc_test-project-key";

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === PROJECT_KEY
          ? { userId: "user-1", projectId: "proj-1" }
          : null,
    },
    project: {
      findUnique: async () => ({ id: "proj-1", organizationId: "org-1" }),
    },
    user: {
      findUnique: async () => ({ email: "dev@example.com" }),
    },
  },
}));

// One plain OAuth provider and one fragment-callback provider (Trello-shaped),
// both instrumented so the redirect_uri each hook receives can be asserted.
vi.mock("../apps/registry", () => ({
  getApp: (id: string) =>
    id === "unifiedapp"
      ? {
          id,
          name: "Unified App",
          available: true,
          connectionMethod: {
            type: "oauth",
            defaultScopes: ["scope.read"],
            buildAuthUrl: (params: { redirectUri: string; state: string }) => {
              captured.authUrl.push({
                redirectUri: params.redirectUri,
                state: params.state,
              });
              return `https://provider.example.com/authorize?redirect_uri=${encodeURIComponent(params.redirectUri)}`;
            },
            exchangeCode: async (params: {
              redirectUri: string;
              callbackParams: Record<string, string>;
            }) => {
              captured.exchange.push({
                redirectUri: params.redirectUri,
                callbackParams: params.callbackParams,
              });
              if (!params.callbackParams.code) {
                throw new Error("missing authorization code");
              }
              return {
                credentials: { access_token: "tok" },
                scopes: ["scope.read"],
                metadata: { username: "user@example.com" },
              };
            },
          },
          configurable: {
            fields: [
              { name: "clientId" },
              { name: "clientSecret", secret: true },
            ],
          },
        }
      : id === "fragmentapp"
        ? {
            id,
            name: "Fragment App",
            available: true,
            connectionMethod: {
              type: "oauth",
              fragmentCallback: { paramName: "token" },
            },
          }
        : undefined,
  getApps: () => [],
}));

vi.mock("../apps/resolve-credentials", () => ({
  resolveAppCredentials: vi.fn(),
}));

// Keep the pure helpers (extractLabel) real; stub only what would hit the
// database or the crypto provider.
vi.mock("../services/connection-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/connection-service")>();
  return {
    ...actual,
    listConnections: vi.fn(async () => []),
    listConnectionsByProvider: vi.fn(async () => []),
    createConnection: vi.fn(async () => ({ id: "conn-new", label: null })),
    reconnectConnection: vi.fn(async () => ({ id: "conn-new" })),
    linkConnectionToAppConfig: vi.fn(async () => undefined),
  };
});

vi.mock("../lib/gateway-invalidate", () => ({
  invalidateGatewayCache: vi.fn(),
  invalidateGatewayCacheForAccount: vi.fn(),
}));

import { createApiApp } from "../app";
import { signOAuthState, generateNonce } from "../lib/oauth-state";
import { resolveAppCredentials } from "../apps/resolve-credentials";
import type { ResolvedAppCredentials } from "../apps/resolve-credentials";

const resolveMock = vi.mocked(resolveAppCredentials);

const CREDS: ResolvedAppCredentials = {
  values: { clientId: "cid", clientSecret: "sec" },
  source: "app_config",
  appConfigId: "cfg-1",
};

const API_ORIGIN = "http://api.example.com";
const authorizeHeaders = {
  host: "api.example.com",
  authorization: `Bearer ${PROJECT_KEY}`,
};

describe("unified OAuth callback (#301)", () => {
  let app: Hono<ApiEnv>;

  beforeAll(() => {
    app = createApiApp({ getSession: async () => null });
  });

  beforeEach(() => {
    captured.authUrl.length = 0;
    captured.exchange.length = 0;
    resolveMock.mockReset();
  });

  describe("GET /apps/:provider/authorize — redirect URI selection", () => {
    it("sends the unified redirect URI for a config stamped at save time", async () => {
      resolveMock.mockResolvedValue({ ...CREDS, redirectStyle: "unified" });

      const res = await app.request("/v1/apps/unifiedapp/authorize", {
        headers: authorizeHeaders,
      });

      expect(res.status).toBe(302);
      expect(captured.authUrl.at(-1)?.redirectUri).toBe(
        `${API_ORIGIN}/v1/apps/callback`,
      );
      // The state cookie must be scoped to the path the flow will land on.
      expect(res.headers.get("set-cookie")).toContain("Path=/v1/apps/callback");
    });

    it("keeps the per-provider redirect URI for an unstamped config", async () => {
      resolveMock.mockResolvedValue(CREDS);

      const res = await app.request("/v1/apps/unifiedapp/authorize", {
        headers: authorizeHeaders,
      });

      expect(res.status).toBe(302);
      expect(captured.authUrl.at(-1)?.redirectUri).toBe(
        `${API_ORIGIN}/v1/apps/unifiedapp/callback`,
      );
      expect(res.headers.get("set-cookie")).toContain(
        "Path=/v1/apps/unifiedapp/callback",
      );
    });
  });

  describe("GET /apps/callback — provider from the signed state", () => {
    const signedState = (extra: Record<string, unknown> = {}) =>
      signOAuthState({
        provider: "unifiedapp",
        projectId: "proj-1",
        nonce: generateNonce(),
        origin: API_ORIGIN,
        ...extra,
      });

    it("completes the flow and hands the exchange the unified redirect URI", async () => {
      resolveMock.mockResolvedValue({ ...CREDS, redirectStyle: "unified" });

      const res = await app.request(
        `/v1/apps/callback?code=abc&state=${encodeURIComponent(signedState())}`,
        { headers: { host: "api.example.com" } },
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        `${API_ORIGIN}/app-connect/unifiedapp?status=success&connected=conn-new&projectId=proj-1`,
      );
      // The exchange must repeat the URI the authorization request used — the
      // unified path, not the per-provider one.
      expect(captured.exchange.at(-1)?.redirectUri).toBe(
        `${API_ORIGIN}/v1/apps/callback`,
      );
    });

    it("serves the fragment bridge from the state cookie alone", async () => {
      // Fragment providers return everything in the URL fragment: the request
      // has no query params at all, so the provider can only come from the
      // oauth_state cookie /authorize scoped to the unified path.
      const state = signOAuthState({
        provider: "fragmentapp",
        nonce: generateNonce(),
        origin: "https://signed.example.com",
      });

      const res = await app.request("/v1/apps/callback", {
        headers: {
          host: "api.example.com",
          cookie: `oauth_state=${state}`,
        },
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toContain(
        "https://signed.example.com/app-connect/fragmentapp",
      );
    });

    it("fails flat with 400 when there is no state at all", async () => {
      const res = await app.request("/v1/apps/callback?code=abc", {
        headers: { host: "api.example.com" },
      });
      expect(res.status).toBe(400);
    });

    it("fails flat with 400 on a state that does not verify", async () => {
      const res = await app.request(
        "/v1/apps/callback?code=abc&state=not-a-signed-state",
        { headers: { host: "api.example.com" } },
      );
      expect(res.status).toBe(400);
    });

    it("fails flat with 400 when the signed provider is not registered", async () => {
      const ghost = signOAuthState({
        provider: "ghost",
        projectId: "proj-1",
        nonce: generateNonce(),
      });
      const res = await app.request(
        `/v1/apps/callback?code=abc&state=${encodeURIComponent(ghost)}`,
        { headers: { host: "api.example.com" } },
      );
      expect(res.status).toBe(400);
    });
  });

  describe("GET /apps/:provider/callback — unchanged for legacy flows", () => {
    it("still hands the exchange the per-provider redirect URI", async () => {
      resolveMock.mockResolvedValue(CREDS);

      const state = signOAuthState({
        provider: "unifiedapp",
        projectId: "proj-1",
        nonce: generateNonce(),
        origin: API_ORIGIN,
      });

      const res = await app.request(
        `/v1/apps/unifiedapp/callback?code=abc&state=${encodeURIComponent(state)}`,
        { headers: { host: "api.example.com" } },
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        `${API_ORIGIN}/app-connect/unifiedapp?status=success&connected=conn-new&projectId=proj-1`,
      );
      expect(captured.exchange.at(-1)?.redirectUri).toBe(
        `${API_ORIGIN}/v1/apps/unifiedapp/callback`,
      );
    });
  });
});
