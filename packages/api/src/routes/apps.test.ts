import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../types";

// Route-level tests for the app-permission catalog endpoints: both must serve
// only the public projection (id/name/description) — the endpoint mapping
// (hostPattern/pathPattern/method/aliasPatterns) never leaves the server.

const ORG_KEY = "oc_org_test-key";

// Hermetic to the ambient edition (CI runs with NEXT_PUBLIC_EDITION=cloud):
// pin everything before any import evaluates (vi.hoisted runs first).
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem-slim";
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
