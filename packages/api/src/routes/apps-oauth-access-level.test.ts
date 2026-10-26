import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../types";

/**
 * The access level an OAuth app lets the user choose (e.g. Attio's workspace
 * vs personal token), through the workspace-scoped routes: `/authorize`
 * validates `?access_level=` against the app's declared options, signs it into
 * the state, and hands it to `buildAuthUrl`; the unauthenticated callback
 * reads it back from the verified state only, never from its own query.
 */

const WORKSPACE_KEY = "oc_test-workspace-key";

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

// What each leg hands the provider adapter: the value under test.
const captured = vi.hoisted(() => ({
  authorize: [] as (string | undefined)[],
  exchange: [] as (string | undefined)[],
}));

const oauthApp = (id: string, withLevels: boolean) => ({
  id,
  name: id,
  connectionMethod: {
    type: "oauth",
    defaultScopes: ["read"],
    ...(withLevels
      ? {
          accessLevels: {
            label: "Access level",
            defaultValue: "workspace",
            options: [
              { value: "workspace", label: "Workspace", description: "All." },
              { value: "user", label: "Personal", description: "You." },
            ],
          },
        }
      : {}),
    buildAuthUrl: async ({ accessLevel }: { accessLevel?: string }) => {
      captured.authorize.push(accessLevel);
      return "https://provider.example/auth";
    },
    exchangeCode: async ({ accessLevel }: { accessLevel?: string }) => {
      captured.exchange.push(accessLevel);
      return {
        credentials: { access_token: "tok" },
        scopes: ["read"],
        metadata: { email: "acct@example.com" },
      };
    },
  },
});

vi.mock("../apps/registry", () => ({
  getApp: (id: string) =>
    id === "leveled"
      ? oauthApp(id, true)
      : id === "plain"
        ? oauthApp(id, false)
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
  findInstallationConnection: async () => null,
}));

vi.mock("../services/agent-connect-grant-service", () => ({
  resolveConnectingAgent: async () => undefined,
  grantConnectingAgent: async () => undefined,
}));

vi.mock("../lib/gateway-invalidate", () => ({
  invalidateGatewayCache: () => undefined,
  invalidateGatewayCacheForAccount: () => undefined,
}));

import { createApiApp } from "../app";
import { verifyOAuthState } from "../lib/oauth-state";

describe("OAuth access level on the workspace routes", () => {
  let app: Hono<ApiEnv>;

  beforeAll(() => {
    app = createApiApp({ getSession: async () => null });
  });

  beforeEach(() => {
    captured.authorize.length = 0;
    captured.exchange.length = 0;
  });

  const authorize = (provider: string, query = "") =>
    app.request(`/v1/apps/${provider}/authorize${query}`, {
      headers: {
        authorization: `Bearer ${WORKSPACE_KEY}`,
        host: "api.example.com",
      },
    });

  // The state the route signed rides the oauth_state cookie verbatim.
  const signedState = (res: Response) =>
    decodeURIComponent(
      /oauth_state=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]!,
    );

  const callback = (provider: string, state: string, extra = "") =>
    app.request(
      `/v1/apps/${provider}/callback?code=abc&state=${encodeURIComponent(state)}${extra}`,
      { headers: { host: "api.example.com" } },
    );

  it("signs the chosen level and asks the provider for it", async () => {
    const res = await authorize("leveled", "?access_level=user");
    expect(res.status).toBe(302);
    expect(captured.authorize).toEqual(["user"]);
    expect(verifyOAuthState(signedState(res))?.accessLevel).toBe("user");
  });

  it("uses the app's default when the request names none", async () => {
    const res = await authorize("leveled");
    expect(res.status).toBe(302);
    expect(captured.authorize).toEqual(["workspace"]);
  });

  it("rejects a level the app does not declare, without echoing it", async () => {
    const res = await authorize("leveled", "?access_level=%3Cscript%3E");
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("script");
    expect(captured.authorize).toEqual([]);
  });

  it("ignores the param for an app that declares no levels", async () => {
    const res = await authorize("plain", "?access_level=user");
    expect(res.status).toBe(302);
    expect(captured.authorize).toEqual([undefined]);
    expect(verifyOAuthState(signedState(res))).not.toHaveProperty(
      "accessLevel",
    );
  });

  it("exchanges with the signed level, never the callback's own query", async () => {
    const res = await authorize("leveled", "?access_level=user");
    const cb = await callback(
      "leveled",
      signedState(res),
      "&access_level=workspace",
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toContain("status=success");
    expect(captured.exchange).toEqual(["user"]);
  });
});
