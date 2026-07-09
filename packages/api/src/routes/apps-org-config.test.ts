import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-level tests for the org tier of the configured-ness signals: with the
// `orgAppConfig` seam registered (EE editions), org-level app configs surface
// on the project endpoints — the grid union (GET /apps/configured) and the
// config status (GET /apps/:provider/config) — per the pinned fallback rule:
// the org tier substitutes only when the project tier has no ENABLED row.
// Without the seam (OSS), both endpoints behave exactly as before.

// Hermetic to the ambient edition (CI runs with NEXT_PUBLIC_EDITION=cloud):
// pin everything before any import evaluates (vi.hoisted runs first).
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem-slim";
});

const USER = "user-1";
const ORG = "org-1";
const DEFAULT_PROJECT = "proj-default";

const store = vi.hoisted(() => ({
  projectRow: null as {
    settings: Record<string, string>;
    credentials: string | null;
    enabled: boolean;
  } | null,
  projectConfigured: [] as { provider: string }[],
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: { findUnique: async () => null },
    user: {
      findUnique: async ({ select }: { select?: Record<string, unknown> }) =>
        select?.organizationMemberships
          ? { organizationMemberships: [{ organizationId: ORG }] }
          : { id: USER, email: "admin@localhost" },
    },
    organizationMember: {
      findFirst: async () => ({ organizationId: ORG }),
    },
    project: {
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where?.id
          ? { id: where.id, organizationId: ORG, createdByUserId: USER }
          : { id: DEFAULT_PROJECT, organizationId: ORG },
      findUnique: async () => ({ organizationId: ORG }),
    },
    appConfig: {
      findUnique: async ({
        where,
      }: {
        where: { projectId_provider?: unknown };
      }) => (where.projectId_provider ? store.projectRow : null),
      findMany: async () => store.projectConfigured,
    },
  },
}));

import { createApiApp } from "../app";
import { initOrgAppConfig, type OrgAppConfigProvider } from "../providers";

const ambientSession = {
  getSession: async () => ({ id: "local-admin", email: "admin@localhost" }),
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

describe("apps routes — org-level config signals", () => {
  beforeEach(() => {
    initOrgAppConfig(null);
    store.projectRow = null;
    store.projectConfigured = [];
  });

  describe("GET /apps/configured", () => {
    it("unions project and org providers when the seam is registered", async () => {
      store.projectConfigured = [{ provider: "aaa" }];
      const app = makeApp({ bbb: { hasCredentials: true } });
      const res = await app.request("/v1/apps/configured");
      expect(res.status).toBe(200);
      expect(((await res.json()) as string[]).sort()).toEqual(["aaa", "bbb"]);
    });

    it("dedupes a provider configured at both scopes", async () => {
      store.projectConfigured = [{ provider: "aaa" }];
      const app = makeApp({ aaa: { hasCredentials: true } });
      const res = await app.request("/v1/apps/configured");
      expect(await res.json()).toEqual(["aaa"]);
    });

    it("without the seam (OSS), lists project providers only", async () => {
      store.projectConfigured = [{ provider: "aaa" }];
      const res = await makeApp().request("/v1/apps/configured");
      expect(await res.json()).toEqual(["aaa"]);
    });
  });

  describe("GET /apps/:provider/config", () => {
    it("no project row + org config → org-inherited status", async () => {
      const app = makeApp({ testapp: { hasCredentials: true } });
      const res = await app.request("/v1/apps/testapp/config");
      expect(await res.json()).toEqual({
        hasCredentials: true,
        enabled: true,
        source: "organization",
      });
    });

    it("an enabled project row keeps today's exact shape (no source)", async () => {
      store.projectRow = {
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

    it("a disabled project row is shadowed by the org config", async () => {
      store.projectRow = {
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

    it("without the seam (OSS), a disabled row is returned as before", async () => {
      store.projectRow = {
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
