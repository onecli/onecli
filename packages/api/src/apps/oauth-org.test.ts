import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "hono";
import type { Prisma } from "@onecli/db";
import type { AuthContext } from "../providers";

// The suite must be hermetic to the ambient edition (CI bakes
// NEXT_PUBLIC_EDITION=cloud into the whole workflow, under which oauth-state
// requires OAUTH_STATE_SECRET and origin resolution ignores request headers).
// Pinned oss so the header-derived origin these cases assert is exercised.
// lib/env captures the env at first load, so pin everything before any import
// evaluates (vi.hoisted runs first).
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = "test-oauth-state-secret";
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
  // The redirect-URI assertions pin the header-origin fallback — an ambient
  // API_URL would flip configuredApiUrl() and shadow it.
  delete process.env.API_URL;
});

// requireOrgDoor's admin threshold rides CAPS.rbac (captured at lib/env
// load) — flip it per test through a mutable getter.
const caps = vi.hoisted(() => ({ rbac: false }));

vi.mock("../lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/env")>();
  return {
    ...actual,
    CAPS: {
      ...actual.CAPS,
      get rbac() {
        return caps.rbac;
      },
    },
  };
});

// In-memory store driving the hand-rolled @onecli/db mock (repo convention —
// see services/organization-service.test.ts).
const store = vi.hoisted(() => ({
  members: [] as { organizationId: string; userId: string; role: string }[],
  // The OAuth legs' inputs, captured so the tests pin what actually leaves
  // for the provider (redirect URI, code) — not just the stored row.
  authUrlArgs: null as {
    redirectUri: string;
    state: string;
    accessLevel?: string;
  } | null,
  exchangeArgs: null as {
    redirectUri: string;
    callbackParams: Record<string, string>;
    accessLevel?: string;
    state?: Record<string, unknown>;
    stateCookie?: string;
  } | null,
  throwOnExchange: false,
  // The scopes the fixture provider reports as granted (null = none reported).
  grantedScopes: null as string[] | null,
  // When set, the fixture asks for one more provider round trip.
  continueAt: null as string | null,
  connections: [] as {
    id: string;
    organizationId?: string;
    workspaceId?: string;
    scope: string;
    provider: string;
    label: string | null;
    status: string;
    credentials: string;
    scopes: string[];
    metadata?: Record<string, unknown>;
    connectedAt: Date;
  }[],
  seq: 0,
  orgFlushes: [] as string[],
  audits: [] as Prisma.AuditLogCreateArgs["data"][],
}));

vi.mock("@onecli/db", () => ({
  Prisma: { TransactionIsolationLevel: { ReadCommitted: "ReadCommitted" } },
  db: {
    $transaction: async <T>(
      run: (tx: typeof import("@onecli/db").db) => Promise<T>,
    ) => {
      const { db } = await import("@onecli/db");
      return run(db);
    },
    $queryRaw: async () => [],
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === "user-1" ? { email: "admin@example.com" } : null,
    },
    auditLog: {
      create: async ({ data }: Prisma.AuditLogCreateArgs) => {
        store.audits.push(data);
        return data;
      },
    },
    organizationMember: {
      findUnique: async ({
        where,
      }: {
        where: {
          organizationId_userId: { organizationId: string; userId: string };
        };
      }) => {
        const { organizationId, userId } = where.organizationId_userId;
        return (
          store.members.find(
            (m) => m.organizationId === organizationId && m.userId === userId,
          ) ?? null
        );
      },
    },
    appConnection: {
      findMany: async ({
        where,
      }: {
        where: { organizationId?: string; scope?: string; provider?: string };
      }) =>
        store.connections.filter(
          (c) =>
            (!where.organizationId ||
              c.organizationId === where.organizationId) &&
            (!where.scope || c.scope === where.scope) &&
            (!where.provider || c.provider === where.provider),
        ),
      findFirst: async ({
        where,
      }: {
        where: {
          id?: string;
          organizationId?: string;
          workspaceId?: string;
          metadata?: { path: string[]; equals: string };
        };
      }) =>
        store.connections.find(
          (c) =>
            (!where.id || c.id === where.id) &&
            (!where.organizationId ||
              c.organizationId === where.organizationId) &&
            (!where.workspaceId || c.workspaceId === where.workspaceId) &&
            // The installation lookup: by metadata.installationId, in org-1.
            (!where.metadata ||
              c.metadata?.installationId === where.metadata.equals),
        ) ?? null,
      create: async ({
        data,
      }: {
        data: Omit<
          (typeof store.connections)[number],
          "id" | "connectedAt" | "label"
        > & { label: string | null };
      }) => {
        const row = {
          ...data,
          id: `conn-${++store.seq}`,
          connectedAt: new Date(),
        };
        store.connections.push(row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<(typeof store.connections)[number]>;
      }) => {
        const row = store.connections.find((c) => c.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      },
    },
    appConfig: {
      // Org-level BYO credentials for the oauth fixture (settings-only, no
      // encrypted blob → no crypto in the credential-resolve path).
      findUnique: async () => ({
        settings: {
          clientId: "cid-1",
          clientSecret: "csec-1",
          appId: "byoc-7",
        },
        credentials: null,
        enabled: true,
      }),
    },
  },
}));

vi.mock("../lib/gateway-invalidate", () => ({
  invalidateGatewayCacheForOrg: (organizationId: string) => {
    store.orgFlushes.push(organizationId);
  },
  invalidateGatewayCacheForAccount: () => {},
  invalidateGatewayCache: () => {},
}));

vi.mock("../lib/logger", () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  };
  return { logger };
});

vi.mock("./registry", () => ({
  getApp: (id: string) =>
    id === "github-app"
      ? {
          id: "github-app",
          name: "GitHub App",
          icon: "/icons/github.svg",
          description: "GitHub App test double",
          connectionMethod: {
            type: "oauth",
            buildAuthUrl: ({ state }: { state: string }) => {
              store.authUrlArgs = { redirectUri: "", state };
              return `https://github.example/install?state=${encodeURIComponent(state)}`;
            },
            // The real app's rule: only a setup redirect may arrive stateless.
            acceptsCookieOnlyState: (params: Record<string, string>) =>
              typeof params.installation_id === "string" &&
              typeof params.setup_action === "string",
            // Stands for the real app AFTER its ownership proof passed.
            exchangeCode: async () => ({
              credentials: {
                type: "github_app",
                installation_id: "4242",
                app_id: "123",
                private_key: "PEM",
                access_token: "ghs_x",
              },
              scopes: ["contents:read"],
              metadata: {
                username: "acme",
                accountType: "Organization",
                installationId: "4242",
              },
            }),
          },
          // Same fields the mocked org config answers with: a customer's
          // own app (appId "byoc-7"), unless a test makes it the platform's.
          configurable: {
            fields: [
              { name: "clientId", label: "Client ID", placeholder: "id" },
              { name: "appId", label: "App ID", placeholder: "id" },
            ],
          },
        }
      : id === "keyapp"
        ? {
            id: "keyapp",
            name: "Key App",
            icon: "/icons/keyapp.svg",
            description: "API-key test app",
            connectionMethod: {
              type: "api_key",
              fields: [
                { name: "apiKey", label: "API Key", placeholder: "key" },
              ],
            },
          }
        : id === "oauthapp"
          ? {
              id: "oauthapp",
              name: "OAuth App",
              icon: "/icons/oauthapp.svg",
              description: "OAuth test app",
              connectionMethod: {
                type: "oauth",
                defaultScopes: ["read", "write"],
                permissions: [
                  {
                    scope: "write",
                    name: "Write",
                    description: "Change things",
                    access: "write",
                  },
                ],
                buildAuthUrl: ({
                  state,
                  redirectUri,
                  accessLevel,
                }: {
                  state: string;
                  redirectUri: string;
                  accessLevel?: string;
                }) => {
                  store.authUrlArgs = { redirectUri, state, accessLevel };
                  return `https://provider.example/auth?state=${encodeURIComponent(state)}`;
                },
                continueCallback: async () =>
                  store.continueAt
                    ? { continueAt: store.continueAt, state: "next-leg-state" }
                    : null,
                exchangeCode: async ({
                  redirectUri,
                  callbackParams,
                  accessLevel,
                  state,
                  stateCookie,
                }: {
                  redirectUri: string;
                  callbackParams: Record<string, string>;
                  accessLevel?: string;
                  state?: Record<string, unknown>;
                  stateCookie?: string;
                }) => {
                  if (store.throwOnExchange) {
                    throw new Error("exchange refused by provider");
                  }
                  store.exchangeArgs = {
                    redirectUri,
                    callbackParams,
                    ...(accessLevel ? { accessLevel } : {}),
                    state,
                    stateCookie,
                  };
                  return {
                    credentials: { access_token: "xchg-1" },
                    ...(store.grantedScopes
                      ? { scopes: store.grantedScopes }
                      : {}),
                  };
                },
                accessLevels: {
                  label: "Access level",
                  defaultValue: "workspace",
                  options: [
                    {
                      value: "workspace",
                      label: "Workspace",
                      description: "All.",
                    },
                    { value: "user", label: "Personal", description: "You." },
                  ],
                },
              },
              configurable: {
                fields: [
                  { name: "clientId", label: "Client ID", placeholder: "id" },
                  {
                    name: "clientSecret",
                    label: "Client Secret",
                    placeholder: "secret",
                    secret: true,
                  },
                ],
              },
            }
          : undefined,
  getApps: () => [],
}));

import { initCrypto } from "../providers";
import {
  generateNonce,
  signOAuthState,
  verifyOAuthState,
} from "../lib/oauth-state";
import {
  orgConnect,
  orgAuthorize,
  tryHandleOrgConnect,
  tryHandleOrgAuthorize,
  tryHandleOrgCallback,
} from "./oauth-org";

initCrypto({
  encrypt: async (plaintext) => `enc:${plaintext}`,
  decrypt: async (encrypted) => encrypted.slice(4),
});

const auth: AuthContext = {
  userId: "user-1",
  userEmail: "admin@example.com",
  organizationId: "org-1",
};

beforeEach(() => {
  store.members = [
    { organizationId: "org-1", userId: "user-1", role: "owner" },
  ];
  store.connections = [];
  store.seq = 0;
  store.orgFlushes = [];
  store.audits = [];
  store.authUrlArgs = null;
  store.exchangeArgs = null;
  store.throwOnExchange = false;
  store.grantedScopes = null;
  store.continueAt = null;
  caps.rbac = false;
});

describe("orgConnect", () => {
  it("creates an org-scoped connection and flushes the whole org", async () => {
    const res = await orgConnect(
      auth,
      "keyapp",
      "org-1",
      { access_token: "sk-1" },
      { metadata: { name: "API Key" } },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(store.connections).toHaveLength(1);
    expect(store.connections[0]).toMatchObject({
      organizationId: "org-1",
      scope: "organization",
      provider: "keyapp",
      status: "connected",
      credentials: 'enc:{"access_token":"sk-1"}',
    });
    expect(store.orgFlushes).toEqual(["org-1"]);
  });

  it("reconnects an existing connection with the same label instead of duplicating", async () => {
    await orgConnect(
      auth,
      "keyapp",
      "org-1",
      { access_token: "old" },
      { metadata: { email: "bot@example.com" } },
    );
    await orgConnect(
      auth,
      "keyapp",
      "org-1",
      { access_token: "new" },
      { metadata: { email: "bot@example.com" } },
    );

    expect(store.connections).toHaveLength(1);
    expect(store.connections[0]?.credentials).toBe(
      'enc:{"access_token":"new"}',
    );
  });

  it("rejects a caller who is not a member of the organization", async () => {
    const res = await orgConnect(
      auth,
      "keyapp",
      "org-other",
      { access_token: "sk" },
      undefined,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Not a member of this organization",
    });
    expect(store.connections).toHaveLength(0);
  });
});

describe("tryHandleOrgConnect (compat interceptor)", () => {
  it("returns null when no X-Organization-Id header is present", async () => {
    const request = new Request("http://localhost/v1/apps/keyapp/connect", {
      method: "POST",
    });
    const res = await tryHandleOrgConnect(auth, request, "keyapp", {
      access_token: "sk",
    });
    expect(res).toBeNull();
    expect(store.connections).toHaveLength(0);
  });

  it("delegates to the org core when the header is present", async () => {
    const request = new Request("http://localhost/v1/apps/keyapp/connect", {
      method: "POST",
      headers: { "x-organization-id": "org-1" },
    });
    const res = await tryHandleOrgConnect(auth, request, "keyapp", {
      access_token: "sk",
    });
    expect(res?.status).toBe(200);
    expect(store.connections[0]).toMatchObject({
      organizationId: "org-1",
      scope: "organization",
    });
  });
});

const fakeContext = (query: Record<string, string | undefined>) => {
  const setCookies: string[] = [];
  return {
    ctx: {
      req: {
        query: (key: string) => query[key],
        // Hono always carries the underlying Request; orgAuthorize reads it to
        // resolve the origin it signs into the state.
        raw: new Request(
          "http://dashboard.example/v1/apps/oauthapp/authorize",
          {
            headers: { host: "dashboard.example" },
          },
        ),
      },
      header: (name: string, value: string) => {
        if (name.toLowerCase() === "set-cookie") setCookies.push(value);
      },
      redirect: (url: string) =>
        new Response(null, { status: 302, headers: { location: url } }),
    } as unknown as Context,
    setCookies,
  };
};

describe("orgAuthorize", () => {
  it("redirects to the provider with an org-scoped signed state", async () => {
    const { ctx } = fakeContext({});
    const res = await orgAuthorize(auth, ctx, "oauthapp", "org-1");

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toMatch(/^https:\/\/provider\.example\/auth\?state=/);

    // The destination is decided here, at the authenticated end, and signed —
    // the shared callback that reads it back is unauthenticated.
    const raw = new URL(location!).searchParams.get("state");
    expect(verifyOAuthState(raw!)).toMatchObject({
      organizationId: "org-1",
      scope: "organization",
      origin: "http://dashboard.example",
    });
  });

  it("rejects non-members of the target organization", async () => {
    const { ctx } = fakeContext({});
    const res = await orgAuthorize(auth, ctx, "oauthapp", "org-other");
    expect(res.status).toBe(403);
  });

  it("rejects non-oauth providers", async () => {
    const { ctx } = fakeContext({});
    const res = await orgAuthorize(auth, ctx, "keyapp", "org-1");
    expect(res.status).toBe(400);
  });

  it("signs the chosen access level and asks the provider for it", async () => {
    const { ctx } = fakeContext({ access_level: "user" });
    const res = await orgAuthorize(auth, ctx, "oauthapp", "org-1");

    expect(res.status).toBe(302);
    expect(store.authUrlArgs?.accessLevel).toBe("user");
    expect(verifyOAuthState(store.authUrlArgs!.state)?.accessLevel).toBe(
      "user",
    );
  });

  it("rejects an access level the app does not declare", async () => {
    const { ctx } = fakeContext({ access_level: "admin" });
    const res = await orgAuthorize(auth, ctx, "oauthapp", "org-1");

    expect(res.status).toBe(400);
    expect(store.authUrlArgs).toBeNull();
  });
});

describe("tryHandleOrgAuthorize (compat interceptor)", () => {
  it("returns null when no _org query is present", async () => {
    const { ctx } = fakeContext({});
    const res = await tryHandleOrgAuthorize(auth, ctx, "oauthapp");
    expect(res).toBeNull();
  });

  it("delegates to the org core when _org is present", async () => {
    const { ctx } = fakeContext({ _org: "org-1" });
    const res = await tryHandleOrgAuthorize(auth, ctx, "oauthapp");
    expect(res?.status).toBe(302);
  });
});

describe("tryHandleOrgCallback (shared-callback interceptor)", () => {
  const orgState = (payload?: Record<string, unknown>) =>
    signOAuthState({
      organizationId: "org-1",
      provider: "oauthapp",
      scope: "organization",
      nonce: generateNonce(),
      origin: "http://dashboard.example",
      userId: "user-1",
      ...payload,
    });

  const callbackRequest = (state?: string) =>
    new Request(
      `http://api.example/v1/apps/oauthapp/callback?code=abc${
        state ? `&state=${encodeURIComponent(state)}` : ""
      }`,
      { headers: { host: "api.example" } },
    );

  it("returns null without a state param (workspace dance untouched)", async () => {
    expect(
      await tryHandleOrgCallback(callbackRequest(), "oauthapp"),
    ).toBeNull();
  });

  it("returns null for a non-organization state (workspace dance untouched)", async () => {
    const state = signOAuthState({
      workspaceId: "ws-1",
      provider: "oauthapp",
      nonce: generateNonce(),
      origin: "http://dashboard.example",
    });
    expect(
      await tryHandleOrgCallback(callbackRequest(state), "oauthapp"),
    ).toBeNull();
  });

  it("connecting at the org level an installation a workspace holds moves that connection up: one connection, same id", async () => {
    store.connections.push({
      id: "conn-ws",
      workspaceId: "ws-1",
      scope: "workspace",
      provider: "github-app",
      label: "acme",
      status: "connected",
      credentials:
        'enc:{"type":"github_app","installation_id":"4242","app_id":"123","private_key":"PEM","access_token":"ghs_old"}',
      scopes: [],
      metadata: { installationId: "4242" },
      connectedAt: new Date(),
    });
    const state = orgState({ provider: "github-app" });
    const res = await tryHandleOrgCallback(
      new Request(
        `http://api.example/v1/apps/github-app/callback?code=abc&state=${encodeURIComponent(state)}`,
        { headers: { host: "api.example" } },
      ),
      "github-app",
    );
    expect(res?.status).toBe(302);
    expect(res?.headers.get("location")).toBe(
      "http://dashboard.example/app-connect/github-app?status=success",
    );
    expect(store.connections).toHaveLength(1);
    expect(store.connections[0]).toMatchObject({
      id: "conn-ws",
      provider: "github-app",
      scope: "organization",
      organizationId: "org-1",
      workspaceId: null,
      credentials: `enc:${JSON.stringify({
        type: "github_app",
        installation_id: "4242",
        app_id: "123",
        private_key: "PEM",
        access_token: "ghs_x",
      })}`,
    });
    expect(store.orgFlushes).toContain("org-1");
    expect(store.audits).toEqual([
      {
        organizationId: "org-1",
        userId: "user-1",
        userEmail: "admin@example.com",
        action: "update",
        service: "app-connection",
        source: "api",
        status: "success",
        metadata: {
          connectionId: "conn-ws",
          provider: "github-app",
          change: "promoted_to_organization",
        },
      },
    ]);
    // A subsequent same-scope re-auth is not another promotion.
    const again = await tryHandleOrgCallback(
      new Request(
        `http://api.example/v1/apps/github-app/callback?code=abc&state=${encodeURIComponent(state)}`,
        { headers: { host: "api.example" } },
      ),
      "github-app",
    );
    expect(again?.headers.get("location")).toContain("status=success");
    expect(store.audits).toHaveLength(1);
  });

  it("does not reconnect a different GitHub installation with the same label", async () => {
    store.connections.push({
      id: "other-installation",
      organizationId: "org-1",
      scope: "organization",
      provider: "github-app",
      label: "acme",
      status: "connected",
      credentials: "enc:other-installation",
      scopes: [],
      metadata: { installationId: "9999" },
      connectedAt: new Date(),
    });
    const state = orgState({ provider: "github-app" });
    const res = await tryHandleOrgCallback(
      new Request(
        `http://api.example/v1/apps/github-app/callback?code=abc&state=${encodeURIComponent(state)}`,
        { headers: { host: "api.example" } },
      ),
      "github-app",
    );
    expect(res?.headers.get("location")).toContain("status=success");
    expect(store.connections).toHaveLength(2);
    expect(store.connections[0]?.credentials).toBe("enc:other-installation");
    expect(store.connections[1]?.metadata?.installationId).toBe("4242");
    expect(store.audits).toEqual([]);
  });

  it.each(["missing", "revoked"])(
    "refuses GitHub org persistence when the initiating actor is %s",
    async (actor) => {
      if (actor === "revoked") store.members = [];
      const state = orgState({
        provider: "github-app",
        ...(actor === "missing" ? { userId: undefined } : {}),
      });
      const res = await tryHandleOrgCallback(
        new Request(
          `http://api.example/v1/apps/github-app/callback?code=abc&state=${encodeURIComponent(state)}`,
          { headers: { host: "api.example" } },
        ),
        "github-app",
      );
      expect(res?.headers.get("location")).toContain("status=error");
      expect(res?.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(store.connections).toHaveLength(0);
    },
  );

  it("a GitHub 'Configure' setup redirect (no state in the query) completes from this browser's cookie", async () => {
    const state = orgState({ provider: "github-app" });
    const res = await tryHandleOrgCallback(
      new Request(
        "http://api.example/v1/apps/github-app/callback?installation_id=4242&setup_action=update",
        {
          headers: {
            host: "api.example",
            cookie: `oauth_state=${encodeURIComponent(state)}`,
          },
        },
      ),
      "github-app",
    );
    expect(res?.status).toBe(302);
    expect(res?.headers.get("location")).toBe(
      "http://dashboard.example/app-connect/github-app?status=success",
    );
    expect(store.connections[0]).toMatchObject({
      organizationId: "org-1",
      scope: "organization",
    });
  });

  it("any other provider's callback without a state is NOT completed from the cookie", async () => {
    // A code from someone else's sign-in, sent to a victim's browser that has
    // a pending org flow: the cookie must not adopt it.
    const res = await tryHandleOrgCallback(
      new Request(
        "http://api.example/v1/apps/oauthapp/callback?code=attacker-code",
        {
          headers: {
            host: "api.example",
            cookie: `oauth_state=${encodeURIComponent(orgState())}`,
          },
        },
      ),
      "oauthapp",
    );
    expect(res).toBeNull();
    expect(store.exchangeArgs).toBeNull();
    expect(store.connections).toHaveLength(0);
  });

  it("a GitHub callback that is not a setup redirect also needs its state", async () => {
    const res = await tryHandleOrgCallback(
      new Request("http://api.example/v1/apps/github-app/callback?code=abc", {
        headers: {
          host: "api.example",
          cookie: `oauth_state=${encodeURIComponent(orgState({ provider: "github-app" }))}`,
        },
      }),
      "github-app",
    );
    expect(res).toBeNull();
    expect(store.connections).toHaveLength(0);
  });

  it("every finished flow clears the state cookie, so a later stateless redirect can't reuse it", async () => {
    const cleared = (res: Response | null) => {
      const cookie = res?.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("oauth_state=;");
      expect(cookie).toContain("Max-Age=0");
      expect(cookie).toContain("Path=/v1/apps/oauthapp/callback");
    };
    cleared(
      await tryHandleOrgCallback(callbackRequest(orgState()), "oauthapp"),
    );
    store.throwOnExchange = true;
    cleared(
      await tryHandleOrgCallback(callbackRequest(orgState()), "oauthapp"),
    );
  });

  it("a forged cookie state is ignored (workspace dance untouched)", async () => {
    expect(
      await tryHandleOrgCallback(
        new Request("http://api.example/v1/apps/oauthapp/callback?code=abc", {
          headers: { host: "api.example", cookie: "oauth_state=not-signed" },
        }),
        "oauthapp",
      ),
    ).toBeNull();
  });

  it("exchanges the code into an org-scoped connection and flushes the org", async () => {
    const res = await tryHandleOrgCallback(
      callbackRequest(orgState()),
      "oauthapp",
    );

    expect(res?.status).toBe(302);
    // The signed origin from /authorize decides the destination — never this
    // unauthenticated request's headers.
    expect(res?.headers.get("location")).toBe(
      "http://dashboard.example/app-connect/oauthapp?status=success",
    );
    // The exchange leg rebuilds the redirect URI from the API origin the
    // request arrived on (getApiCallbackOrigin) — never the defaulted
    // localhost selfUrl — and forwards the provider's code untouched.
    expect(store.exchangeArgs).toEqual({
      redirectUri: "http://api.example/v1/apps/oauthapp/callback",
      callbackParams: expect.objectContaining({ code: "abc" }),
      // A state minted before the level existed exchanges at the default.
      accessLevel: "workspace",
      state: expect.objectContaining({ organizationId: "org-1" }),
      stateCookie: undefined,
    });
    expect(store.connections).toHaveLength(1);
    expect(store.connections[0]).toMatchObject({
      organizationId: "org-1",
      scope: "organization",
      provider: "oauthapp",
      status: "connected",
      // The exchanged credentials — encrypted — are what lands in the row.
      credentials: 'enc:{"access_token":"xchg-1"}',
    });
    expect(store.orgFlushes).toEqual(["org-1"]);
  });

  it("exchanges with the level signed into the state", async () => {
    const res = await tryHandleOrgCallback(
      callbackRequest(orgState({ accessLevel: "user" })),
      "oauthapp",
    );

    expect(res?.status).toBe(302);
    expect(store.exchangeArgs?.accessLevel).toBe("user");
  });

  it("a partial grant tells the popup what's missing and how to retry this org connection", async () => {
    store.grantedScopes = ["read"];
    const res = await tryHandleOrgCallback(
      callbackRequest(orgState()),
      "oauthapp",
    );

    const location = new URL(res?.headers.get("location") ?? "");
    expect(Object.fromEntries(location.searchParams)).toEqual({
      status: "success",
      missing: "write",
      // The retry re-authenticates the org connection just created, in the
      // org: never a workspace, and never a second connection.
      connectionId: store.connections[0]?.id,
      orgId: "org-1",
    });
  });

  it("a continuation redirects with the next leg's state cookie and stores nothing", async () => {
    store.continueAt = "https://provider.example/next";
    const state = orgState();

    const res = await tryHandleOrgCallback(
      new Request(
        `http://api.example/v1/apps/oauthapp/callback?installation_id=1&state=${encodeURIComponent(state)}`,
        { headers: { host: "api.example" } },
      ),
      "oauthapp",
    );

    expect(res?.status).toBe(302);
    expect(res?.headers.get("location")).toBe("https://provider.example/next");
    const cookie = res?.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("oauth_state=next-leg-state");
    // Scoped to the callback path the next leg returns to.
    expect(cookie).toContain("Path=/v1/apps/oauthapp/callback");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(store.exchangeArgs).toBeNull();
    expect(store.connections).toHaveLength(0);
    expect(store.orgFlushes).toEqual([]);
  });

  it("hands the exchange this browser's state cookie for the callback", async () => {
    const state = orgState();
    await tryHandleOrgCallback(
      new Request(
        `http://api.example/v1/apps/oauthapp/callback?code=abc&state=${encodeURIComponent(state)}`,
        {
          headers: {
            host: "api.example",
            cookie: `other=1; oauth_state=${encodeURIComponent(state)}`,
          },
        },
      ),
      "oauthapp",
    );

    expect(store.exchangeArgs?.stateCookie).toBe(state);
  });

  it("redirects to the error page instead of minting when the exchange fails", async () => {
    // An unknown provider id fails before any exchange or write.
    const res = await tryHandleOrgCallback(
      callbackRequest(orgState({ provider: "missingapp" })),
      "missingapp",
    );

    expect(res?.status).toBe(302);
    expect(res?.headers.get("location")).toContain(
      "/app-connect/missingapp?status=error",
    );
    expect(store.connections).toHaveLength(0);
  });

  it("a thrown exchange lands on the error page with no row and no flush", async () => {
    store.throwOnExchange = true;

    const res = await tryHandleOrgCallback(
      callbackRequest(orgState()),
      "oauthapp",
    );

    expect(res?.status).toBe(302);
    const location = res?.headers.get("location") ?? "";
    expect(location).toContain("/app-connect/oauthapp?status=error");
    expect(location).toContain(encodeURIComponent("exchange refused"));
    expect(store.connections).toHaveLength(0);
    expect(store.orgFlushes).toEqual([]);
  });
});

describe("the org-door admin threshold (roles enforced)", () => {
  // The legacy interceptors ride PLAIN-auth workspace endpoints, so the
  // admin threshold must live in the shared cores — a member who is 403'd on
  // the canonical /org/apps route must not get in via the X-Organization-Id
  // header. Flat teams (rbac off, the default in this file) pass every
  // active member; these pin the enforced arm.
  beforeEach(() => {
    caps.rbac = true;
    store.members = [
      { organizationId: "org-1", userId: "user-1", role: "member" },
    ];
  });

  it("orgConnect refuses a plain member where roles are enforced", async () => {
    const res = await orgConnect(auth, "keyapp", "org-1", {
      access_token: "sk-1",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Insufficient permissions" });
    expect(store.connections).toHaveLength(0);
  });

  it("orgAuthorize refuses a plain member where roles are enforced", async () => {
    const { ctx } = fakeContext({});
    const res = await orgAuthorize(auth, ctx, "oauthapp", "org-1");
    expect(res.status).toBe(403);
  });

  it("an admin still passes with roles enforced", async () => {
    store.members = [
      { organizationId: "org-1", userId: "user-1", role: "admin" },
    ];
    const res = await orgConnect(auth, "keyapp", "org-1", {
      access_token: "sk-1",
    });
    expect(res.status).toBe(200);
    expect(store.connections).toHaveLength(1);
  });
});

describe("Install GitHub for skills only", () => {
  const skillsState = (payload?: Record<string, unknown>) =>
    signOAuthState({
      organizationId: "org-1",
      provider: "github-app",
      scope: "organization",
      nonce: generateNonce(),
      origin: "http://dashboard.example",
      userId: "user-1",
      purpose: "skills",
      ...payload,
    });
  const ghCallback = (state: string) =>
    new Request(
      `http://api.example/v1/apps/github-app/callback?code=abc&state=${encodeURIComponent(state)}`,
      { headers: { host: "api.example" } },
    );

  it("authorize signs purpose=skills (and who started it) for the GitHub App only", async () => {
    const { ctx } = fakeContext({ purpose: "skills" });
    await orgAuthorize(auth, ctx, "github-app", "org-1");
    expect(verifyOAuthState(store.authUrlArgs!.state)).toMatchObject({
      purpose: "skills",
      userId: auth.userId,
    });

    const other = fakeContext({ purpose: "skills" });
    await orgAuthorize(auth, other.ctx, "oauthapp", "org-1");
    expect(verifyOAuthState(store.authUrlArgs!.state)?.purpose).toBeUndefined();
  });

  it("the callback stores NO connection and hands back a grant for this org and user", async () => {
    const res = await tryHandleOrgCallback(
      ghCallback(skillsState()),
      "github-app",
    );
    expect(res?.status).toBe(302);
    expect(store.connections).toHaveLength(0);
    expect(store.orgFlushes).toHaveLength(0);

    const location = new URL(res!.headers.get("location")!);
    expect(location.pathname).toBe("/app-connect/github-app");
    expect(location.searchParams.get("status")).toBe("library");
    // The grant rides the fragment (never sent to a server).
    expect(location.search).not.toContain("g=");
    const grant = decodeURIComponent(location.hash.replace(/^#g=/, ""));
    const { readLibraryGrant } =
      await import("../services/skill-library-grant");
    expect(
      readLibraryGrant(grant, { organizationId: "org-1", userId: "user-1" }),
    ).toEqual({
      installationId: "4242",
      account: "acme",
      accountType: "Organization",
    });
    expect(() =>
      readLibraryGrant(grant, { organizationId: "org-1", userId: "user-2" }),
    ).toThrow();
    // No credential in the grant.
    expect(Buffer.from(grant, "base64url").toString()).not.toMatch(/PEM|ghs_/);
  });

  it("without purpose=skills the same callback still creates the org connection", async () => {
    const res = await tryHandleOrgCallback(
      ghCallback(skillsState({ purpose: undefined })),
      "github-app",
    );
    expect(res?.status).toBe(302);
    expect(store.connections).toHaveLength(1);
  });

  describe("the platform GitHub App (one key for every customer)", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("without its ownership check, skills-only is refused at authorize and at the callback: no grant", async () => {
      // The org's app IS the platform app, and no OAuth client proves the
      // installation id a setup redirect names.
      vi.stubEnv("GITHUB_APP_ID", "byoc-7");
      vi.stubEnv("GITHUB_APP_CLIENT_ID", "");
      vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "");

      const { ctx } = fakeContext({ purpose: "skills" });
      const refused = await orgAuthorize(auth, ctx, "github-app", "org-1");
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({
        error: expect.stringMatching(/isn't available here/),
      });
      expect(store.authUrlArgs).toBeNull();

      // A state minted before the config changed is refused too.
      const res = await tryHandleOrgCallback(
        ghCallback(skillsState()),
        "github-app",
      );
      const location = new URL(res!.headers.get("location")!);
      expect(location.searchParams.get("status")).toBe("error");
      expect(location.hash).toBe("");
      expect(store.connections).toHaveLength(0);
    });

    it("with its ownership check, skills-only is offered", async () => {
      vi.stubEnv("GITHUB_APP_ID", "byoc-7");
      vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.client");
      vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "secret");
      const { ctx } = fakeContext({ purpose: "skills" });
      await orgAuthorize(auth, ctx, "github-app", "org-1");
      expect(verifyOAuthState(store.authUrlArgs!.state)?.purpose).toBe(
        "skills",
      );
    });
  });
});
