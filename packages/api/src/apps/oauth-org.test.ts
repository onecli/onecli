import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "hono";
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
  authUrlArgs: null as { redirectUri: string; state: string } | null,
  exchangeArgs: null as {
    redirectUri: string;
    callbackParams: Record<string, string>;
  } | null,
  throwOnExchange: false,
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
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
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
        where: { id?: string; organizationId?: string };
      }) =>
        store.connections.find(
          (c) =>
            (!where.id || c.id === where.id) &&
            (!where.organizationId ||
              c.organizationId === where.organizationId),
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
        settings: { clientId: "cid-1", clientSecret: "csec-1" },
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
    id === "keyapp"
      ? {
          id: "keyapp",
          name: "Key App",
          icon: "/icons/keyapp.svg",
          description: "API-key test app",
          connectionMethod: {
            type: "api_key",
            fields: [{ name: "apiKey", label: "API Key", placeholder: "key" }],
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
              defaultScopes: ["read"],
              buildAuthUrl: ({
                state,
                redirectUri,
              }: {
                state: string;
                redirectUri: string;
              }) => {
                store.authUrlArgs = { redirectUri, state };
                return `https://provider.example/auth?state=${encodeURIComponent(state)}`;
              },
              exchangeCode: async ({
                redirectUri,
                callbackParams,
              }: {
                redirectUri: string;
                callbackParams: Record<string, string>;
              }) => {
                if (store.throwOnExchange) {
                  throw new Error("exchange refused by provider");
                }
                store.exchangeArgs = { redirectUri, callbackParams };
                return { credentials: { access_token: "xchg-1" } };
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
  store.authUrlArgs = null;
  store.exchangeArgs = null;
  store.throwOnExchange = false;
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
