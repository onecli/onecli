import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../types";

// Route-level tests for the app-permission catalog endpoints: both must serve
// only the public projection (id/name/description) — the endpoint mapping
// (hostPattern/pathPattern/method/aliasPatterns) never leaves the server.

const ORG_KEY = "oc_org_test-key";

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
        where.key === ORG_KEY
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
      findUnique: async () => ({
        organizationId: "org-1",
        userId: "user-1",
        role: "owner",
      }),
    },
  },
}));

// Two known apps: "keyapp" has a permission definition, "noperm" does not.
// The "ghost" permission definition below has no app at all.
vi.mock("../apps/registry", () => ({
  getApp: (id: string) =>
    id === "keyapp" || id === "noperm"
      ? { id, name: id, icon: `/icons/${id}.svg`, description: id }
      : undefined,
  getApps: () => [],
}));

import { createApiApp } from "../app";
import { registerAppPermission } from "../apps/app-permissions";

registerAppPermission({
  provider: "keyapp",
  groups: [
    {
      category: "read",
      wildcard: {
        id: "read_all",
        name: "All read operations",
        description: "Everything read",
        hostPattern: "api.keyapp.com",
        pathPattern: "/api/*",
        method: "GET",
      },
      tools: [
        {
          id: "read_one",
          name: "Read one",
          description: "Reads one",
          hostPattern: "api.keyapp.com",
          pathPattern: "/api/one",
          aliasPatterns: ["/alias/one"],
          method: "GET",
        },
      ],
    },
  ],
});

// Registered definition without a registered app — must never be advertised.
registerAppPermission({
  provider: "ghost",
  groups: [
    {
      category: "write",
      tools: [
        {
          id: "w1",
          name: "W1",
          description: "",
          hostPattern: "api.ghost.com",
          pathPattern: "/w1",
          method: "POST",
        },
      ],
    },
  ],
});

const nullSession = { getSession: async () => null };
const orgKeyHeaders = { authorization: `Bearer ${ORG_KEY}` };

const SLIM_KEYAPP = {
  provider: "keyapp",
  groups: [
    {
      category: "read",
      wildcard: {
        id: "read_all",
        name: "All read operations",
        description: "Everything read",
      },
      // read_one's "/alias/one" alias escapes the "/api/*" wildcard, so the
      // umbrella isn't a true superset — the server marks it incomplete and the
      // picker won't offer it.
      wildcardComplete: false,
      tools: [{ id: "read_one", name: "Read one", description: "Reads one" }],
    },
  ],
};

describe("app-permission catalog endpoints", () => {
  let app: Hono<ApiEnv>;

  beforeAll(() => {
    app = createApiApp(nullSession);
  });

  it("GET /apps/permission-definitions lists slim catalogs for apps that exist", async () => {
    const res = await app.request("/v1/apps/permission-definitions", {
      headers: orgKeyHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provider: string }[];

    expect(body).toContainEqual(SLIM_KEYAPP);
    expect(body.map((d) => d.provider)).not.toContain("ghost");
    const json = JSON.stringify(body);
    for (const leaked of [
      "hostPattern",
      "pathPattern",
      "aliasPatterns",
      "method",
    ]) {
      expect(json).not.toContain(leaked);
    }
  });

  it("GET /apps/:provider/permission-definition serves the slim catalog", async () => {
    const res = await app.request("/v1/apps/keyapp/permission-definition", {
      headers: orgKeyHeaders,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SLIM_KEYAPP);
  });

  it("keeps the 404 split: unknown provider vs app without a catalog", async () => {
    const unknown = await app.request("/v1/apps/ghost/permission-definition", {
      headers: orgKeyHeaders,
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "Unknown provider: ghost" });

    const noDef = await app.request("/v1/apps/noperm/permission-definition", {
      headers: orgKeyHeaders,
    });
    expect(noDef.status).toBe(404);
    expect(await noDef.json()).toEqual({
      error: "No permission definition for provider: noperm",
    });
  });

  it("requires auth", async () => {
    const res = await app.request("/v1/apps/permission-definitions");
    expect(res.status).toBe(401);
  });
});

// Where the OAuth callback sends the browser when the dance ends. An unknown
// provider is the cheapest way in: it short-circuits to the "Invalid provider"
// error redirect, which is built from the same `appOrigin` as every success and
// failure path in the handler.
describe("oauth callback redirect origin", () => {
  let app: Hono<ApiEnv>;

  beforeAll(() => {
    app = createApiApp(nullSession);
  });

  const orig = {
    APP_URL: process.env.APP_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  };
  afterEach(() => {
    for (const key of ["APP_URL", "NEXT_PUBLIC_APP_URL"] as const) {
      if (orig[key] === undefined) delete process.env[key];
      else process.env[key] = orig[key];
    }
  });

  const callback = (headers: Record<string, string>) =>
    app.request("/v1/apps/nosuchprovider/callback", { headers });

  const invalidProviderAt = (origin: string) =>
    `${origin}/app-connect/nosuchprovider?status=error&message=Invalid%20provider`;

  // The reported bug (OSS #420): APP_URL is unset, so the handler used to read
  // lib/env.ts's `http://localhost:10254` default and strand the user there.
  it("falls back to the request origin when APP_URL is unconfigured", async () => {
    delete process.env.APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;

    const res = await callback({ host: "my-gateway.example.com" });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      invalidProviderAt("http://my-gateway.example.com"),
    );
  });

  it("honors a configured APP_URL, stripping trailing slashes", async () => {
    process.env.APP_URL = "https://configured.example.com/";
    delete process.env.NEXT_PUBLIC_APP_URL;

    const res = await callback({ host: "my-gateway.example.com" });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      invalidProviderAt("https://configured.example.com"),
    );
  });

  // The split-origin deployment shape is covered in
  // apps-callback-origin.test.ts, which needs its own edition pin.
});
