import { beforeEach, describe, expect, it, vi } from "vitest";

// Request-level coverage for the freed org-credential doors: /v1/org/secrets
// and /v1/org/connections through the REAL middleware chain (org API key →
// flat-team role gate → handler), plus the wire-compat aliases. The routers
// were enterprise-gated until the org-credentials carve; these pin the free
// posture the carve promises: they answer on an unlicensed self-host, fenced
// by the caller's organization.

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = "test-oauth-state-secret";
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
});

const ORG_KEY = "oc_org_test-key";

const store = vi.hoisted(() => ({
  members: [{ organizationId: "org-1", userId: "user-1", role: "owner" }],
  connections: [] as {
    id: string;
    organizationId?: string | null;
    workspaceId?: string | null;
    scope: string;
    provider: string;
    label: string | null;
    status: string;
    credentials: string;
    scopes: string[];
    connectedAt: Date;
  }[],
  secrets: [] as {
    id: string;
    organizationId?: string | null;
    scope: string;
    name: string;
    type: string;
    value: string;
    hostPattern: string | null;
    createdAt: Date;
  }[],
  seq: 0,
  orgFlushes: [] as string[],
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === ORG_KEY
          ? { userId: "user-1", organizationId: "org-1", scope: "organization" }
          : null,
    },
    user: {
      findUnique: async () => ({ id: "user-1", email: "admin@example.com" }),
    },
    organizationMember: {
      findUnique: async () => store.members[0] ?? null,
      findFirst: async () => store.members[0] ?? null,
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
      delete: async ({ where }: { where: { id: string } }) => {
        const i = store.connections.findIndex((c) => c.id === where.id);
        if (i < 0) throw new Error("not found");
        return store.connections.splice(i, 1)[0];
      },
    },
    secret: {
      findMany: async ({ where }: { where: { organizationId?: string } }) =>
        store.secrets.filter(
          (s) =>
            !where.organizationId || s.organizationId === where.organizationId,
        ),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          hostPattern: null,
          ...data,
          id: `sec-${++store.seq}`,
          createdAt: new Date(),
        } as (typeof store.secrets)[number];
        store.secrets.push(row);
        return row;
      },
    },
    auditLog: { create: async () => ({}) },
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

import { createApiApp } from "../app";
import { initCrypto, initResourceHooks } from "../providers";

const beforeCreateSecret = vi.fn(async () => {});

const app = createApiApp(
  { getSession: async () => null },
  { eeRoutes: () => {} },
);
initCrypto({
  encrypt: async (plaintext: string) => `enc:${plaintext}`,
  decrypt: async (encrypted: string) => encrypted.slice(4),
});
initResourceHooks({
  beforeCreateAgent: async () => {},
  beforeCreateSecret,
});

const orgKeyHeaders = {
  authorization: `Bearer ${ORG_KEY}`,
  "content-type": "application/json",
};

beforeEach(() => {
  store.connections = [
    {
      id: "conn-1",
      organizationId: "org-1",
      workspaceId: null,
      scope: "organization",
      provider: "resend",
      label: "Org Resend",
      status: "connected",
      credentials: "enc:{}",
      scopes: [],
      connectedAt: new Date(),
    },
  ];
  store.secrets = [];
  store.seq = 0;
  store.orgFlushes = [];
  beforeCreateSecret.mockClear();
});

describe("/v1/org/connections (free, org-fenced)", () => {
  it("lists the org's connections", async () => {
    const res = await app.request("/v1/org/connections", {
      headers: orgKeyHeaders,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject([
      { id: "conn-1", provider: "resend", scope: "organization" },
    ]);
  });

  it("renames a connection and flushes the whole org", async () => {
    const res = await app.request("/v1/org/connections/conn-1", {
      method: "PATCH",
      headers: orgKeyHeaders,
      body: JSON.stringify({ label: "Renamed" }),
    });
    expect(res.status).toBe(200);
    expect(store.connections[0]?.label).toBe("Renamed");
    expect(store.orgFlushes).toContain("org-1");
  });

  it("deletes a connection", async () => {
    const res = await app.request("/v1/org/connections/conn-1", {
      method: "DELETE",
      headers: orgKeyHeaders,
    });
    expect(res.status).toBe(204);
    expect(store.connections).toHaveLength(0);
  });

  it("keeps the legacy /v1/org/apps/connections alias byte-identical", async () => {
    const res = await app.request("/v1/org/apps/connections", {
      headers: orgKeyHeaders,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject([{ id: "conn-1" }]);
  });
});

describe("/v1/org/secrets (free, org-fenced)", () => {
  it("creates an org secret through the plan-quota seam", async () => {
    const res = await app.request("/v1/org/secrets", {
      method: "POST",
      headers: orgKeyHeaders,
      body: JSON.stringify({
        name: "org-token",
        type: "generic",
        value: "tok-1",
        hostPattern: "api.internal.example.com",
        injectionConfig: { headerName: "x-token" },
      }),
    });
    expect(res.status).toBe(201);
    // The quota question rides the provider seam — cloud enforces there,
    // self-host no-ops — never a static quota-service import.
    expect(beforeCreateSecret).toHaveBeenCalledWith("org-1");
    expect(store.secrets[0]).toMatchObject({
      organizationId: "org-1",
      scope: "organization",
      name: "org-token",
    });
  });

  it("lists only the caller's org secrets", async () => {
    store.secrets = [
      {
        id: "sec-own",
        organizationId: "org-1",
        scope: "organization",
        name: "ours",
        type: "generic",
        value: "enc:x",
        hostPattern: "a.example.com",
        createdAt: new Date(),
      },
      {
        id: "sec-foreign",
        organizationId: "org-2",
        scope: "organization",
        name: "theirs",
        type: "generic",
        value: "enc:y",
        hostPattern: "b.example.com",
        createdAt: new Date(),
      },
    ];

    const res = await app.request("/v1/org/secrets", {
      headers: orgKeyHeaders,
    });
    expect(res.status).toBe(200);
    const names = ((await res.json()) as { name: string }[]).map((s) => s.name);
    // The planted foreign row: the org fence is in the QUERY, so another
    // org's secret is invisible, not just unauthorized.
    expect(names).toEqual(["ours"]);
  });
});
