import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../types";

// Route-level tests for the /workspaces surface as the cloud edition mounts it —
// the headless provisioning path for the org API key (list/create/rename/
// delete against the key's organization), exercising the real middleware
// chain and workspace-service against the hand-rolled @onecli/db mock.

const ORG_KEY = "oc_org_test-key";

// Pin the edition + signing key before any import evaluates (vi.hoisted runs
// first) — this suite pins the cloud semantics (CAPS.rbac on) regardless of
// the ambient env.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  process.env.SECRET_ENCRYPTION_KEY = "test-oauth-state-secret";
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
});

interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  organizationId: string;
  createdByUserId: string;
  createdByUserEmail: string;
  createdAt: Date;
}

const store = vi.hoisted(() => ({
  members: [] as { organizationId: string; userId: string; role: string }[],
  workspaces: [] as {
    id: string;
    name: string;
    slug: string;
    organizationId: string;
    createdByUserId: string;
    createdByUserEmail: string;
    createdAt: Date;
  }[],
  apiKeys: [] as { key: string; userId: string; workspaceId: string }[],
  agents: [] as { workspaceId: string }[],
  flushedKeys: [] as string[],
}));

vi.mock("@onecli/db", () => {
  // Everything the factory uses must live inside it (vi.mock hoists above
  // top-level declarations); `store` is safe because it is vi.hoisted.
  // The routes select {id, name, slug, createdAt}; honor `select` on workspace
  // reads so the asserted response shapes match production.
  const pickWorkspace = (
    row: (typeof store.workspaces)[number],
    select?: Record<string, boolean>,
  ) => {
    if (!select) return row;
    return Object.fromEntries(
      Object.keys(select)
        .filter((k) => select[k])
        .map((k) => [k, row[k as keyof typeof row]]),
    );
  };

  type WorkspaceWhere = {
    id?: string | { in?: string[] };
    organizationId?: string;
    createdByUserId?: string;
    slug?: string;
    NOT?: { id?: string };
  };

  const matchWorkspace = (
    p: (typeof store.workspaces)[number],
    where: WorkspaceWhere,
  ) => {
    if (typeof where.id === "string" && p.id !== where.id) return false;
    if (where.organizationId && p.organizationId !== where.organizationId) {
      return false;
    }
    if (where.createdByUserId && p.createdByUserId !== where.createdByUserId) {
      return false;
    }
    if (where.slug && p.slug !== where.slug) return false;
    if (where.NOT?.id && p.id === where.NOT.id) return false;
    return true;
  };

  const workspaceModel = () => ({
    findMany: async ({
      where,
      select,
    }: {
      where: WorkspaceWhere;
      select?: Record<string, boolean>;
    }) =>
      store.workspaces
        .filter((p) => matchWorkspace(p, where))
        .map((p) => pickWorkspace(p, select)),
    findFirst: async ({
      where,
      select,
    }: {
      where: WorkspaceWhere;
      select?: Record<string, boolean>;
    }) => {
      const row = store.workspaces.find((p) => matchWorkspace(p, where));
      return row ? pickWorkspace(row, select) : null;
    },
    findUnique: async ({
      where,
      select,
    }: {
      where: {
        id?: string;
        organizationId_slug?: { organizationId: string; slug: string };
      };
      select?: Record<string, boolean>;
    }) => {
      const row = where.organizationId_slug
        ? store.workspaces.find(
            (p) =>
              p.organizationId === where.organizationId_slug!.organizationId &&
              p.slug === where.organizationId_slug!.slug,
          )
        : store.workspaces.find((p) => p.id === where.id);
      return row ? pickWorkspace(row, select) : null;
    },
    create: async ({
      data,
      select,
    }: {
      data: Omit<WorkspaceRow, "createdAt">;
      select?: Record<string, boolean>;
    }) => {
      const row = { ...data, createdAt: new Date() };
      store.workspaces.push(row);
      return pickWorkspace(row, select);
    },
    update: async ({
      where,
      data,
      select,
    }: {
      where: { id: string };
      data: Partial<WorkspaceRow>;
      select?: Record<string, boolean>;
    }) => {
      const row = store.workspaces.find((p) => p.id === where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, data);
      return pickWorkspace(row, select);
    },
    count: async ({ where }: { where: WorkspaceWhere }) =>
      store.workspaces.filter((p) => matchWorkspace(p, where)).length,
    delete: async ({ where }: { where: { id: string } }) => {
      store.workspaces = store.workspaces.filter((p) => p.id !== where.id);
      return {};
    },
  });

  const apiKeyModel = () => ({
    findUnique: async ({ where }: { where: { key: string } }) =>
      where.key === ORG_KEY
        ? { userId: "user-1", organizationId: "org-1", scope: "organization" }
        : (store.apiKeys.find((k) => k.key === where.key) ?? null),
    findFirst: async ({
      where,
    }: {
      where: { userId?: string; workspaceId?: string };
    }) =>
      store.apiKeys.find(
        (k) =>
          (!where.userId || k.userId === where.userId) &&
          (!where.workspaceId || k.workspaceId === where.workspaceId),
      ) ?? null,
    findMany: async ({ where }: { where: { workspaceId?: string } }) =>
      store.apiKeys.filter(
        (k) => !where.workspaceId || k.workspaceId === where.workspaceId,
      ),
    create: async ({ data }: { data: (typeof store.apiKeys)[number] }) => {
      store.apiKeys.push(data);
      return data;
    },
    deleteMany: async ({ where }: { where: { workspaceId?: string } }) => {
      store.apiKeys = store.apiKeys.filter(
        (k) => where.workspaceId && k.workspaceId !== where.workspaceId,
      );
      return {};
    },
  });

  const agentModel = () => ({
    findFirst: async ({ where }: { where: { workspaceId?: string } }) =>
      store.agents.find(
        (a) => !where.workspaceId || a.workspaceId === where.workspaceId,
      ) ?? null,
    // The channel teardown asks for a workspace's agents that HAVE presences;
    // none of these fixtures do, so it is an empty list.
    findMany: async () => [],
    create: async ({ data }: { data: { workspaceId: string } }) => {
      store.agents.push({ workspaceId: data.workspaceId });
      return data;
    },
    deleteMany: async ({ where }: { where: { workspaceId?: string } }) => {
      store.agents = store.agents.filter(
        (a) => where.workspaceId && a.workspaceId !== where.workspaceId,
      );
      return {};
    },
  });

  const noopDeleteMany = { deleteMany: async () => ({}) };

  const models = () => ({
    apiKey: apiKeyModel(),
    agent: agentModel(),
    workspace: workspaceModel(),
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
      findMany: async ({ where }: { where: { userId?: string } }) =>
        store.members.filter((m) => !where.userId || m.userId === where.userId),
    },
    user: {
      findUnique: async () => ({ email: "admin@example.com" }),
    },
    workspaceAccess: {
      findFirst: async () => null,
    },
    auditLog: { create: async () => ({}), ...noopDeleteMany },
    requestLog: noopDeleteMany,
    policyRule: noopDeleteMany,
    agentSecret: noopDeleteMany,
    skill: noopDeleteMany,
    agentAppConnection: noopDeleteMany,
    appConnection: noopDeleteMany,
    secret: noopDeleteMany,
    appConfig: noopDeleteMany,
    vaultConnection: noopDeleteMany,
    onboardingSurvey: noopDeleteMany,
  });

  const db = {
    ...models(),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(models()),
  };
  return { Prisma: {}, db };
});

vi.mock("../lib/gateway-invalidate", () => ({
  invalidateGatewayCacheForKeys: (keys: string[]) => {
    store.flushedKeys.push(...keys);
  },
  invalidateGatewayCacheForOrg: () => {},
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

import { createApiApp } from "../app";
import { getUserRole } from "../ee/services/authorization-service";

const nullSession = { getSession: async () => null };
const orgKeyHeaders = {
  authorization: `Bearer ${ORG_KEY}`,
  "content-type": "application/json",
};

let app: Hono<ApiEnv>;

beforeAll(() => {
  // `/workspaces` is mounted by the shared block in `createApiApp` since the
  // licensing split; only the DB-backed role resolver still needs injecting.
  app = createApiApp(nullSession, { roleResolver: { getUserRole } });
});

beforeEach(() => {
  store.members = [
    { organizationId: "org-1", userId: "user-1", role: "owner" },
  ];
  store.workspaces = [
    {
      id: "ws-a",
      name: "Default",
      slug: "default-user-1",
      organizationId: "org-1",
      createdByUserId: "user-1",
      createdByUserEmail: "admin@example.com",
      createdAt: new Date("2026-01-01"),
    },
    {
      id: "ws-b",
      name: "Other",
      slug: "default-user-2",
      organizationId: "org-1",
      createdByUserId: "user-2",
      createdByUserEmail: "other@example.com",
      createdAt: new Date("2026-01-02"),
    },
  ];
  store.apiKeys = [{ key: "oc_a", userId: "user-1", workspaceId: "ws-a" }];
  store.agents = [{ workspaceId: "ws-a" }];
  store.flushedKeys = [];
});

describe("GET /v1/workspaces (org key)", () => {
  it("lists every workspace in the org for owners", async () => {
    const res = await app.request("/v1/workspaces", { headers: orgKeyHeaders });

    expect(res.status).toBe(200);
    const workspaces = (await res.json()) as { id: string; slug: string }[];
    expect(workspaces.map((p) => p.id)).toEqual(["ws-a", "ws-b"]);
    // The CLI's resolveWorkspaceID depends on id + slug being present.
    expect(workspaces[0]).toMatchObject({ id: "ws-a", slug: "default-user-1" });
    expect(workspaces[0]).not.toHaveProperty("organizationId");
  });
});

describe("POST /v1/workspaces (org key)", () => {
  it("provisions a workspace with its API key and no agent", async () => {
    const res = await app.request("/v1/workspaces", {
      method: "POST",
      headers: orgKeyHeaders,
      body: JSON.stringify({ name: "Probe User A" }),
    });

    expect(res.status).toBe(201);
    const workspace = (await res.json()) as {
      id: string;
      name: string;
      slug: string;
      apiKey: string | null;
    };
    expect(workspace).toMatchObject({
      name: "Probe User A",
      slug: "probe-user-a",
    });
    // The headless-provisioning contract: the creator's workspace key comes back.
    expect(workspace.apiKey).toMatch(/^oc_/);
    // No agent is seeded — a workspace starts empty and the user creates the
    // agents they want.
    expect(store.agents.some((a) => a.workspaceId === workspace.id)).toBe(
      false,
    );
    // The creator's WorkspaceAccess binding is seeded owner (step 13c) with the workspace.
    const created = store.workspaces.find((p) => p.id === workspace.id) as {
      accessBindings?: unknown;
    };
    expect(created.accessBindings).toEqual({
      create: { userId: "user-1", role: "owner" },
    });
  });

  it("409s on a slug conflict within the shared org", async () => {
    store.workspaces[0]!.slug = "probe-user-a";

    const res = await app.request("/v1/workspaces", {
      method: "POST",
      headers: orgKeyHeaders,
      body: JSON.stringify({ name: "Probe User A" }),
    });

    expect(res.status).toBe(409);
  });

  it("rejects an org key whose user dropped below admin (the demotion re-check)", async () => {
    store.members = [
      { organizationId: "org-1", userId: "user-1", role: "member" },
    ];

    const res = await app.request("/v1/workspaces", {
      method: "POST",
      headers: orgKeyHeaders,
      body: JSON.stringify({ name: "Nope" }),
    });

    expect(res.status).toBe(401);
    expect(store.workspaces).toHaveLength(2);
  });
});

describe("PATCH + DELETE /v1/workspaces/:id (org key)", () => {
  it("renames a workspace (slug follows the name)", async () => {
    const res = await app.request("/v1/workspaces/ws-b", {
      method: "PATCH",
      headers: orgKeyHeaders,
      body: JSON.stringify({ name: "Renamed Team" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: "ws-b",
      name: "Renamed Team",
      slug: "renamed-team",
    });
  });

  it("deletes a workspace transactionally and flushes its keys", async () => {
    store.apiKeys.push({ key: "oc_b", userId: "user-2", workspaceId: "ws-b" });

    const res = await app.request("/v1/workspaces/ws-b", {
      method: "DELETE",
      headers: orgKeyHeaders,
    });

    expect(res.status).toBe(204);
    expect(store.workspaces.map((p) => p.id)).toEqual(["ws-a"]);
    expect(store.apiKeys.some((k) => k.workspaceId === "ws-b")).toBe(false);
    expect(store.flushedKeys).toEqual(["oc_b"]);
  });

  it("refuses to delete the only workspace in the org", async () => {
    store.workspaces = [store.workspaces[0]!];

    const res = await app.request("/v1/workspaces/ws-a", {
      method: "DELETE",
      headers: orgKeyHeaders,
    });

    expect(res.status).toBe(400);
    expect(store.workspaces).toHaveLength(1);
  });

  it("404s a workspace outside the key's organization", async () => {
    store.workspaces.push({
      id: "ws-x",
      name: "Foreign",
      slug: "foreign",
      organizationId: "org-2",
      createdByUserId: "user-9",
      createdByUserEmail: "x@example.com",
      createdAt: new Date("2026-01-03"),
    });

    const res = await app.request("/v1/workspaces/ws-x", {
      method: "DELETE",
      headers: orgKeyHeaders,
    });

    expect(res.status).toBe(404);
  });
});

describe("workspace-scoped key confinement (manage routes)", () => {
  // `oc_a` is bound to ws-a; it must not reach sibling ws-b, even though its
  // user (user-1) could via a session or org key. Closes the blast-radius gap
  // where a leaked workspace key inherits the user's org-wide management authority.
  const wsKeyHeaders = {
    authorization: "Bearer oc_a",
    "content-type": "application/json",
  };

  it("404s a workspace key reaching for a sibling workspace", async () => {
    const res = await app.request("/v1/workspaces/ws-b", {
      method: "PATCH",
      headers: wsKeyHeaders,
      body: JSON.stringify({ name: "Hijacked" }),
    });

    expect(res.status).toBe(404);
    expect(store.workspaces.find((p) => p.id === "ws-b")?.name).not.toBe(
      "Hijacked",
    );
  });

  it("lets a workspace key manage its own workspace", async () => {
    const res = await app.request("/v1/workspaces/ws-a", {
      method: "PATCH",
      headers: wsKeyHeaders,
      body: JSON.stringify({ name: "Own Rename" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: "ws-a",
      name: "Own Rename",
    });
  });

  it("404s a workspace key DELETE reaching for a sibling workspace", async () => {
    // Confinement fires before any role/ownership check, so DELETE is confined
    // to the key's own workspace exactly like PATCH — the sibling survives.
    const res = await app.request("/v1/workspaces/ws-b", {
      method: "DELETE",
      headers: wsKeyHeaders,
    });

    expect(res.status).toBe(404);
    expect(store.workspaces.some((p) => p.id === "ws-b")).toBe(true);
  });
});
