import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-level tests for the org tier of the configured-ness signals: with the
// `orgAppConfig` seam registered (cloud), org-level app configs surface
// on the workspace endpoints — the grid union (GET /apps/configured) and the
// config status (GET /apps/:provider/config) — per the pinned fallback rule:
// the org tier substitutes only when the workspace tier has no ENABLED row.
// With the org provider unwired (a mis-wired host — production servers
// boot-inject it on every edition), both endpoints behave as before.

// Hermetic to the ambient edition (CI runs with NEXT_PUBLIC_EDITION=cloud):
// pin everything before any import evaluates (vi.hoisted runs first). Pinned
// oss so the ambient local session resolves the default workspace header-less.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

const USER = "user-1";
const ORG = "org-1";
const DEFAULT_WORKSPACE = "proj-default";

const store = vi.hoisted(() => ({
  workspaceRow: null as {
    settings: Record<string, string>;
    credentials: string | null;
    enabled: boolean;
  } | null,
  workspaceConfigured: [] as { provider: string }[],
  orgConfigured: [] as { provider: string }[],
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: { findUnique: async () => null },
    user: {
      findUnique: async ({ select }: { select?: Record<string, unknown> }) =>
        select?.organizationMemberships
          ? { organizationMemberships: [{ organizationId: ORG }] }
          : { id: USER, email: "owner@example.test" },
    },
    organizationMember: {
      findFirst: async () => ({ organizationId: ORG }),
    },
    workspace: {
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where?.id
          ? { id: where.id, organizationId: ORG, createdByUserId: USER }
          : { id: DEFAULT_WORKSPACE, organizationId: ORG },
      findUnique: async () => ({ organizationId: ORG }),
    },
    appConfig: {
      findUnique: async ({
        where,
      }: {
        where: { workspaceId_provider?: unknown };
      }) => (where.workspaceId_provider ? store.workspaceRow : null),
      // Where-aware: the boot-injected org provider queries by organizationId;
      // the workspace list queries by workspaceId. A where-blind mock would
      // let the org tier echo workspace rows and pass by coincidence.
      findMany: async ({
        where,
      }: {
        where?: { organizationId?: string };
      } = {}) =>
        where?.organizationId ? store.orgConfigured : store.workspaceConfigured,
    },
  },
}));

import { createApiApp } from "../app";
import { initOrgAppConfig, type OrgAppConfigProvider } from "../providers";

const ambientSession = {
  getSession: async () => ({
    id: "session-sub-1",
    email: "owner@example.test",
  }),
};

const orgSeam = (
  configs: Record<string, { hasCredentials: boolean }>,
): OrgAppConfigProvider => ({
  resolveCredentials: async () => null,
  getEnabledConfig: async (_org, provider) => configs[provider] ?? null,
  listEnabledConfigs: async () => configs,
});

const makeApp = (orgConfigs?: Record<string, { hasCredentials: boolean }>) =>
  createApiApp(
    ambientSession,
    orgConfigs ? { orgAppConfig: orgSeam(orgConfigs) } : undefined,
  );

// Runs FIRST (file order): the boot wiring is an init-override that the
// beforeEach below resets away for the seam-controlled cases, and it never
// re-applies within a worker. MUTATION-TESTED: delete the onprem
// `initOrgAppConfig(orgAppConfig)` injection in edition-defaults.ts and this
// fails — createApiApp is the only thing wiring the org tier here, exactly
// like a real self-hosted boot.
describe("the boot wiring itself (edition-defaults, onprem arm)", () => {
  it("serves the org config tier out of the box", async () => {
    store.orgConfigured = [{ provider: "bbb" }];
    const res = await makeApp().request("/v1/apps/configured");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(["bbb"]);
    store.orgConfigured = [];
  });
});

describe("apps routes — org-level config signals", () => {
  beforeEach(() => {
    initOrgAppConfig(null);
    store.workspaceRow = null;
    store.workspaceConfigured = [];
  });

  describe("GET /apps/configured", () => {
    it("unions workspace and org providers when the seam is registered", async () => {
      store.workspaceConfigured = [{ provider: "aaa" }];
      const app = makeApp({ bbb: { hasCredentials: true } });
      const res = await app.request("/v1/apps/configured");
      expect(res.status).toBe(200);
      expect(((await res.json()) as string[]).sort()).toEqual(["aaa", "bbb"]);
    });

    it("dedupes a provider configured at both scopes", async () => {
      store.workspaceConfigured = [{ provider: "aaa" }];
      const app = makeApp({ aaa: { hasCredentials: true } });
      const res = await app.request("/v1/apps/configured");
      expect(await res.json()).toEqual(["aaa"]);
    });

    it("with the org provider unwired, lists workspace providers only", async () => {
      store.workspaceConfigured = [{ provider: "aaa" }];
      const res = await makeApp().request("/v1/apps/configured");
      expect(await res.json()).toEqual(["aaa"]);
    });
  });

  describe("GET /apps/:provider/config", () => {
    it("no workspace row + org config → org-inherited status", async () => {
      const app = makeApp({ testapp: { hasCredentials: true } });
      const res = await app.request("/v1/apps/testapp/config");
      expect(await res.json()).toEqual({
        hasCredentials: true,
        enabled: true,
        source: "organization",
      });
    });

    it("an enabled workspace row keeps today's exact shape (no source)", async () => {
      store.workspaceRow = {
        settings: { clientId: "p-id" },
        credentials: "enc",
        enabled: true,
      };
      const app = makeApp({ testapp: { hasCredentials: true } });
      const res = await app.request("/v1/apps/testapp/config");
      expect(await res.json()).toEqual({
        settings: { clientId: "p-id" },
        hasCredentials: true,
        enabled: true,
      });
    });

    it("a disabled workspace row is shadowed by the org config", async () => {
      store.workspaceRow = {
        settings: { clientId: "p-id" },
        credentials: "enc",
        enabled: false,
      };
      const app = makeApp({ testapp: { hasCredentials: true } });
      const res = await app.request("/v1/apps/testapp/config");
      expect(await res.json()).toEqual({
        hasCredentials: true,
        enabled: true,
        source: "organization",
      });
    });

    it("with the org provider unwired, a disabled row is returned as before", async () => {
      store.workspaceRow = {
        settings: { clientId: "p-id" },
        credentials: "enc",
        enabled: false,
      };
      const res = await makeApp().request("/v1/apps/testapp/config");
      expect(await res.json()).toEqual({
        settings: { clientId: "p-id" },
        hasCredentials: true,
        enabled: false,
      });
    });

    it("nothing anywhere → the no-config sentinel", async () => {
      const res = await makeApp().request("/v1/apps/testapp/config");
      expect(await res.json()).toEqual({
        hasCredentials: false,
        enabled: false,
      });
    });
  });
});
