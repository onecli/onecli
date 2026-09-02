import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../types";

// Route-level tests for the canonical org connect surface and its legacy
// compat interceptors, exercising the real middleware chain (org API key →
// role gate → handler) against the hand-rolled @onecli/db mock.

const ORG_KEY = "oc_org_test-key";

// This suite pins the unwired and the standard boot-wired semantics, so it
// must be hermetic to the ambient edition: CI runs the whole workflow with
// NEXT_PUBLIC_EDITION=cloud, under which CAPS.rbac flips the org-key auth
// re-check and oauth-state requires OAUTH_STATE_SECRET. Pinned onprem.
// lib/env captures the env at first load, so pin everything before any import
// evaluates (vi.hoisted runs first).
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = "test-oauth-state-secret";
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
});

// Flat team vs enforced roles rides CAPS.rbac (captured at lib/env load) —
// flip it per test through a mutable getter.
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

const store = vi.hoisted(() => ({
  members: [] as { organizationId: string; userId: string; role: string }[],
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
    connectedAt: Date;
  }[],
  seq: 0,
  orgFlushes: [] as string[],
  orgs: [] as { id: string; awsExternalId: string | null }[],
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === "oc_org_test-key"
          ? {
              userId: "user-1",
              organizationId: "org-1",
              scope: "organization",
            }
          : null,
    },
    user: {
      findUnique: async () => ({ email: "admin@example.com" }),
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
      // The flat-team active-membership fence in the auth middleware.
      findFirst: async ({
        where,
      }: {
        where: { organizationId?: string; userId?: string };
      }) =>
        store.members.find(
          (m) =>
            (!where.organizationId ||
              m.organizationId === where.organizationId) &&
            (!where.userId || m.userId === where.userId),
        ) ?? null,
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
      findFirst: async ({ where }: { where: { id?: string } }) =>
        store.connections.find((c) => !where.id || c.id === where.id) ?? null,
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
    organization: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        store.orgs.find((o) => o.id === where.id) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; awsExternalId: null };
        data: { awsExternalId: string };
      }) => {
        const org = store.orgs.find((o) => o.id === where.id);
        if (!org || org.awsExternalId !== null) return { count: 0 };
        org.awsExternalId = data.awsExternalId;
        return { count: 1 };
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
      // The configured-providers list (reached now that flat teams pass the
      // admin gate without a resolver).
      findMany: async () => [],
    },
  },
}));

vi.mock("../lib/gateway-invalidate", () => ({
  invalidateGatewayCacheForOrg: (organizationId: string) => {
    store.orgFlushes.push(organizationId);
  },
  invalidateGatewayCacheForAccount: () => {},
  invalidateGatewayCache: () => {},
  invalidateGatewayCacheForKeys: () => {},
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

vi.mock("../apps/registry", () => ({
  getApp: (id: string) =>
    // A credentials-import app with a SERVER-OWNED field — the aws-role shape,
    // whose external ID must come from the caller's org, never the body.
    id === "serverfieldapp"
      ? {
          id: "serverfieldapp",
          name: "Server Field App",
          icon: "/icons/sf.svg",
          description: "credentials-import app with a server-owned field",
          available: true,
          connectionMethod: {
            type: "credentials_import",
            fields: [
              { name: "roleArn", label: "Role ARN", placeholder: "arn:" },
            ],
            exchangeCredentials: async (fields: Record<string, string>) => ({
              credentials: {
                roleArn: fields.roleArn,
                externalId: fields.externalId,
              },
              scopes: [],
            }),
            serverFields: [{ name: "externalId", source: "orgAwsExternalId" }],
          },
        }
      : id === "keyapp"
        ? {
            id: "keyapp",
            name: "Key App",
            icon: "/icons/keyapp.svg",
            description: "API-key test app",
            available: true,
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
              available: true,
              connectionMethod: {
                type: "oauth",
                defaultScopes: ["read"],
                buildAuthUrl: ({ state }: { state: string }) =>
                  `https://provider.example/auth?state=${encodeURIComponent(state)}`,
                exchangeCode: async () => ({ credentials: {} }),
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

import { createApiApp } from "../app";
import { initRoleResolver, initCrypto, initOAuthOrg } from "../providers";
import { getUserRole } from "../ee/services/authorization-service";
import * as oauthOrg from "../apps/oauth-org";

const nullSession = { getSession: async () => null };
const fakeCrypto = {
  encrypt: async (plaintext: string) => `enc:${plaintext}`,
  decrypt: async (encrypted: string) => encrypted.slice(4),
};

const orgKeyHeaders = {
  authorization: `Bearer ${ORG_KEY}`,
  "content-type": "application/json",
};

beforeEach(() => {
  store.members = [
    { organizationId: "org-1", userId: "user-1", role: "owner" },
    { organizationId: "org-2", userId: "user-2", role: "owner" },
  ];
  store.connections = [];
  store.seq = 0;
  store.orgFlushes = [];
  store.orgs = [
    { id: "org-1", awsExternalId: null },
    { id: "org-2", awsExternalId: "onecli-org-2-external-id" },
  ];
});

// Module-level provider singletons (oauthOrg, roleResolver) are write-once per
// worker, so the boot-wiring and unwired expectations MUST run before the
// wired app is constructed — vitest executes these describes in file order.

describe("the boot wiring itself (edition-defaults, onprem arm)", () => {
  // MUTATION-TESTED: delete the onprem `initOAuthOrg(oauthOrg)` injection in
  // edition-defaults.ts and this fails — createApiApp is the ONLY thing
  // wiring the org handlers here, exactly like a real self-hosted boot.
  it("serves the legacy org connect out of the box", async () => {
    initCrypto(fakeCrypto);
    const app = createApiApp(nullSession, { eeRoutes: () => {} });

    const res = await app.request("/v1/apps/keyapp/connect", {
      method: "POST",
      headers: { ...orgKeyHeaders, "x-organization-id": "org-1" },
      body: JSON.stringify({ fields: { apiKey: "sk-1" } }),
    });

    expect(res.status).toBe(200);
    expect(store.connections[0]).toMatchObject({
      organizationId: "org-1",
      scope: "organization",
      provider: "keyapp",
    });
  });
});

describe("with the org handlers unwired (mis-wired host)", () => {
  let app: Hono<ApiEnv>;

  beforeAll(() => {
    // createApiApp boot-injects the shared org handlers on every edition —
    // undo that here: this describe is exactly the mis-wired-host scenario,
    // whose property is that an explicit org context fails LOUD (400) rather
    // than silently minting a workspace-scoped connection.
    app = createApiApp(nullSession, {
      eeRoutes: () => {},
    });
    initOAuthOrg(null);
    initRoleResolver(null);
  });

  it("fails loud on explicit org context in connect instead of mis-scoping", async () => {
    const res = await app.request("/v1/apps/keyapp/connect", {
      method: "POST",
      headers: { ...orgKeyHeaders, "x-organization-id": "org-1" },
      body: JSON.stringify({ fields: { apiKey: "sk-1" } }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Organization-scoped connections are not supported on this server",
    });
    expect(store.connections).toHaveLength(0);
  });

  it("fails loud on an explicit _org authorize instead of mis-scoping", async () => {
    const res = await app.request("/v1/apps/oauthapp/authorize?_org=org-1", {
      headers: orgKeyHeaders,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Organization-scoped connections are not supported on this server",
    });
  });

  it("flat team: admin-gated org routes open to active members with no resolver", async () => {
    // The org-apps router mounts in the FREE block now, so the request
    // reaches the role gate; membership was proven at key resolution and no
    // RBAC means no role enforcement (caps.rbac defaults false here).
    const res = await app.request("/v1/org/apps/configured", {
      headers: orgKeyHeaders,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("with the standard boot wiring", () => {
  let app: Hono<ApiEnv>;

  beforeAll(() => {
    // Mirrors a booted server: the shared org handlers (nulled by the
    // previous describe) re-wired through the init* seams, plus the
    // DB-backed role resolver for the RBAC arm.
    initCrypto(fakeCrypto);
    initOAuthOrg(oauthOrg);
    app = createApiApp(nullSession, {
      roleResolver: { getUserRole },
      eeRoutes: () => {},
    });
  });

  it("connects an app org-wide via the canonical route with a bare org key", async () => {
    const res = await app.request("/v1/org/apps/keyapp/connect", {
      method: "POST",
      headers: orgKeyHeaders,
      body: JSON.stringify({ fields: { apiKey: "sk-1" } }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(store.connections).toHaveLength(1);
    expect(store.connections[0]).toMatchObject({
      organizationId: "org-1",
      scope: "organization",
      provider: "keyapp",
      status: "connected",
    });
    expect(store.orgFlushes).toEqual(["org-1"]);
  });

  it("keeps the legacy X-Organization-Id connect byte-identical", async () => {
    const res = await app.request("/v1/apps/keyapp/connect", {
      method: "POST",
      headers: { ...orgKeyHeaders, "x-organization-id": "org-1" },
      body: JSON.stringify({ fields: { apiKey: "sk-1" } }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(store.connections[0]).toMatchObject({
      organizationId: "org-1",
      scope: "organization",
      provider: "keyapp",
    });
  });

  it("RBAC: an org key held by a mere member dies at authentication", async () => {
    // With roles enforced, the org-key admin re-check refuses the key itself
    // (a demoted holder's key stops working) — the request never reaches the
    // role gate or the handler.
    caps.rbac = true;
    try {
      store.members = [
        { organizationId: "org-1", userId: "user-1", role: "member" },
      ];

      const res = await app.request("/v1/org/apps/keyapp/connect", {
        method: "POST",
        headers: orgKeyHeaders,
        body: JSON.stringify({ fields: { apiKey: "sk-1" } }),
      });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: {
          message: "Invalid API key or token.",
          type: "authentication_error",
        },
      });
      expect(store.connections).toHaveLength(0);
    } finally {
      caps.rbac = false;
    }
  });

  it("starts an org-scoped OAuth dance via the canonical authorize route", async () => {
    const res = await app.request("/v1/org/apps/oauthapp/authorize", {
      headers: orgKeyHeaders,
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(
      /^https:\/\/provider\.example\/auth\?state=/,
    );
  });

  it("membership-checks an explicit ?org= override", async () => {
    const res = await app.request("/v1/org/apps/oauthapp/authorize?org=org-2", {
      headers: orgKeyHeaders,
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Not a member of this organization",
    });
  });

  it("rejects invalid connect bodies with the shared error strings", async () => {
    const res = await app.request("/v1/org/apps/keyapp/connect", {
      method: "POST",
      headers: orgKeyHeaders,
      body: JSON.stringify({ fields: { apiKey: "  " } }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "API Key is required" });
  });
  // ── AWS external ID ────────────────────────────────────────────────────

  it("returns the caller's org external id, minting it on first read", async () => {
    const res = await app.request("/v1/org/apps/aws-external-id", {
      headers: orgKeyHeaders,
    });

    expect(res.status).toBe(200);
    const { externalId } = (await res.json()) as { externalId: string };
    expect(externalId).toMatch(/^onecli-/);
    // Persisted, so the value the user pastes into their trust policy is the
    // same one we will present at AssumeRole time.
    expect(store.orgs[0]!.awsExternalId).toBe(externalId);
  });

  it("returns the same external id on a second read", async () => {
    const first = await app.request("/v1/org/apps/aws-external-id", {
      headers: orgKeyHeaders,
    });
    const second = await app.request("/v1/org/apps/aws-external-id", {
      headers: orgKeyHeaders,
    });

    expect(await first.json()).toEqual(await second.json());
  });

  it("never serves another org's external id", async () => {
    // The org comes from the membership-fenced auth context, and nothing in
    // the request names one — so org-2's id is unreachable from org-1's key.
    const res = await app.request("/v1/org/apps/aws-external-id", {
      headers: orgKeyHeaders,
    });

    const { externalId } = (await res.json()) as { externalId: string };
    expect(externalId).not.toBe("onecli-org-2-external-id");
  });

  it("RBAC: a mere member cannot read the org external id", async () => {
    caps.rbac = true;
    try {
      store.members = [
        { organizationId: "org-1", userId: "user-1", role: "member" },
      ];

      const res = await app.request("/v1/org/apps/aws-external-id", {
        headers: orgKeyHeaders,
      });

      expect(res.status).toBe(401);
    } finally {
      caps.rbac = false;
    }
  });

  it("refuses a legacy connect naming an org the caller is not in", async () => {
    // The negative control for the cross-tenant arm: `X-Organization-Id` can
    // re-scope this endpoint to another org, and server-owned fields resolve
    // (and lazily WRITE) against whichever org that is.
    //
    // The downstream org handler refuses non-membership too, but only AFTER
    // the resolve has run — so without the fence ahead of it, a stranger's
    // request still MINTS AND PERSISTS an external ID on a foreign org's row.
    // Starting org-2 unset is what makes that write observable here.
    store.orgs[1]!.awsExternalId = null;

    const res = await app.request("/v1/apps/serverfieldapp/connect", {
      method: "POST",
      headers: { ...orgKeyHeaders, "x-organization-id": "org-2" },
      body: JSON.stringify({
        fields: { roleArn: "arn:aws:iam::123456789012:role/R" },
      }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Not a member of this organization",
    });
    expect(store.connections).toHaveLength(0);
    // The row of the org the caller does not belong to was never written.
    expect(store.orgs[1]!.awsExternalId).toBeNull();
  });

  it("connect ignores a client-supplied server field and uses the org's", async () => {
    // The confused-deputy attempt, end to end through the real route: the body
    // carries another org's external id, and it must not survive.
    const res = await app.request("/v1/org/apps/serverfieldapp/connect", {
      method: "POST",
      headers: orgKeyHeaders,
      body: JSON.stringify({
        fields: {
          roleArn: "arn:aws:iam::123456789012:role/R",
          externalId: "onecli-org-2-external-id",
        },
      }),
    });

    expect(res.status).toBe(200);
    const stored = JSON.parse(
      store.connections[0]!.credentials.replace(/^enc:/, ""),
    ) as { externalId: string };
    expect(stored.externalId).toBe(store.orgs[0]!.awsExternalId);
    expect(stored.externalId).not.toBe("onecli-org-2-external-id");
  });
});
