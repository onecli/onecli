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
  deleteTransactionEvents: [] as string[],
  inTransaction: false,
}));

vi.mock("@onecli/db", () => ({
  Prisma: { TransactionIsolationLevel: { Serializable: "Serializable" } },
  db: {
    $transaction: async <T>(
      run: (tx: typeof import("@onecli/db").db) => Promise<T>,
      options: { isolationLevel: string },
    ) => {
      expect(options.isolationLevel).toBe("Serializable");
      const snapshot = structuredClone(store.connections);
      store.inTransaction = true;
      store.deleteTransactionEvents.push("begin");
      try {
        const { db } = await import("@onecli/db");
        const result = await run(db);
        store.deleteTransactionEvents.push("commit");
        return result;
      } catch (error) {
        store.connections = snapshot;
        store.deleteTransactionEvents.push("rollback");
        throw error;
      } finally {
        store.inTransaction = false;
      }
    },
    $queryRaw: async (
      query: TemplateStringsArray,
      id: string,
      organizationId: string,
    ) => {
      expect(store.inTransaction).toBe(true);
      expect(query.join("?")).toBe(
        "SELECT id FROM app_connections WHERE id = ? AND scope = 'organization' AND organization_id = ? FOR UPDATE",
      );
      expect(organizationId).toBe("org-1");
      store.deleteTransactionEvents.push(`lock:${id}`);
      return store.connections
        .filter(
          (row) =>
            row.id === id &&
            row.scope === "organization" &&
            row.organizationId === organizationId,
        )
        .map(({ id }) => ({ id }));
    },
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
        where: {
          organizationId?: string;
          scope?: string;
          provider?: string;
          sourceConnectionId?: string;
        };
      }) =>
        // No connection here is a copy built on another one.
        where.sourceConnectionId
          ? []
          : store.connections.filter(
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
        expect(store.inTransaction).toBe(true);
        expect(store.deleteTransactionEvents).toContain(`lock:${where.id}`);
        store.deleteTransactionEvents.push(`delete:${where.id}`);
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
  store.deleteTransactionEvents = [];
  store.inTransaction = false;
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
    expect(store.deleteTransactionEvents).toEqual([
      "begin",
      "lock:conn-1",
      "delete:conn-1",
      "commit",
    ]);
  });

  it("rolls back a scoped delete when the connection does not exist", async () => {
    const res = await app.request("/v1/org/connections/missing", {
      method: "DELETE",
      headers: orgKeyHeaders,
    });
    expect(res.status).toBe(404);
    expect(store.connections.map(({ id }) => id)).toEqual(["conn-1"]);
    expect(store.deleteTransactionEvents).toEqual([
      "begin",
      "lock:missing",
      "rollback",
    ]);
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
