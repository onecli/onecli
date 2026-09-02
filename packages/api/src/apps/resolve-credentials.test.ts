import { beforeEach, describe, expect, it, vi } from "vitest";

// Pin the edition before any import — lib/env captures env at first load and
// Pin the onprem edition: the no-seam describe exercises the onprem default
// (getOrgAppConfig → null); the cloud describes inject the seam explicitly,
// which wins regardless of edition.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

const WORKSPACE = "proj-1";
const ORG = "org-1";
const ENV_VAR_ID = "RESOLVE_CREDS_TEST_CLIENT_ID";
const ENV_VAR_SECRET = "RESOLVE_CREDS_TEST_CLIENT_SECRET";

// One mutable row per scope; `credentials` stays null so the service returns
// plain `settings` and no crypto is involved (completeness is judged on the
// merged record either way).
const store = vi.hoisted(() => ({
  workspaceRow: null as {
    id: string;
    settings: Record<string, string>;
    credentials: string | null;
    enabled: boolean;
  } | null,
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    appConfig: {
      findUnique: async ({
        where,
      }: {
        where: {
          workspaceId_provider?: unknown;
          organizationId_provider?: unknown;
        };
      }) => (where.workspaceId_provider ? store.workspaceRow : null),
    },
  },
}));

import { resolveAppCredentials } from "./resolve-credentials";
import { initOrgAppConfig } from "../providers";
import type { AppDefinition } from "./types";

// Minimal typed app fixture — the resolver only reads `id` + `configurable`,
// but the full shape keeps the fixture honest (connect-credentials.test.ts
// precedent).
const app: AppDefinition = {
  id: "testapp",
  name: "Test App",
  icon: "/icons/testapp.svg",
  description: "Configurable OAuth test app",
  connectionMethod: {
    type: "oauth",
    buildAuthUrl: () => "https://provider.example/auth",
    exchangeCode: async () => ({ credentials: {}, scopes: [] }),
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
    envDefaults: { clientId: ENV_VAR_ID, clientSecret: ENV_VAR_SECRET },
  },
};

const ORG_RESOLVED = {
  values: { clientId: "org-id", clientSecret: "org-secret" },
  source: "app_config" as const,
};

const orgSeam = () => ({
  resolveCredentials: vi.fn(
    async (): Promise<typeof ORG_RESOLVED | null> => ORG_RESOLVED,
  ),
  getEnabledConfig: vi.fn(async () => null),
  listEnabledConfigs: vi.fn(async () => ({})),
});

describe("resolveAppCredentials — workspace → org → env", () => {
  beforeEach(() => {
    initOrgAppConfig(null); // OSS default: no seam
    store.workspaceRow = null;
    delete process.env[ENV_VAR_ID];
    delete process.env[ENV_VAR_SECRET];
  });

  describe("without the org seam (onprem default)", () => {
    it("resolves a complete enabled workspace row", async () => {
      store.workspaceRow = {
        id: "proj-cfg",
        settings: { clientId: "p-id", clientSecret: "p-secret" },
        credentials: null,
        enabled: true,
      };
      expect(await resolveAppCredentials(WORKSPACE, app, ORG)).toEqual({
        values: { clientId: "p-id", clientSecret: "p-secret" },
        source: "app_config",
        appConfigId: "proj-cfg",
      });
    });

    it("omits appConfigId on the env tier", async () => {
      process.env[ENV_VAR_ID] = "env-id";
      process.env[ENV_VAR_SECRET] = "env-secret";
      const resolved = await resolveAppCredentials(WORKSPACE, app, ORG);
      expect(resolved?.source).toBe("env");
      expect(resolved && "appConfigId" in resolved).toBe(false);
    });

    it("falls to env when there is no workspace row", async () => {
      process.env[ENV_VAR_ID] = "env-id";
      process.env[ENV_VAR_SECRET] = "env-secret";
      expect(await resolveAppCredentials(WORKSPACE, app, ORG)).toEqual({
        values: { clientId: "env-id", clientSecret: "env-secret" },
        source: "env",
      });
    });

    it("returns null when neither workspace row nor env exists", async () => {
      expect(await resolveAppCredentials(WORKSPACE, app, ORG)).toBeNull();
    });
  });

  describe("with the org seam registered (cloud)", () => {
    it("a complete enabled workspace row wins — the org tier is not consulted", async () => {
      const seam = orgSeam();
      initOrgAppConfig(seam);
      store.workspaceRow = {
        id: "proj-cfg",
        settings: { clientId: "p-id", clientSecret: "p-secret" },
        credentials: null,
        enabled: true,
      };
      const resolved = await resolveAppCredentials(WORKSPACE, app, ORG);
      expect(resolved?.values.clientId).toBe("p-id");
      expect(resolved?.appConfigId).toBe("proj-cfg");
      expect(seam.resolveCredentials).not.toHaveBeenCalled();
    });

    it("no workspace row → org tier resolves", async () => {
      const seam = orgSeam();
      initOrgAppConfig(seam);
      expect(await resolveAppCredentials(WORKSPACE, app, ORG)).toEqual(
        ORG_RESOLVED,
      );
      expect(seam.resolveCredentials).toHaveBeenCalledWith(ORG, app);
    });

    it("a disabled workspace row falls through to the org tier", async () => {
      const seam = orgSeam();
      initOrgAppConfig(seam);
      // getAppConfigCredentials returns null for disabled rows; mirror that by
      // the row being invisible on the merged read — the service filters it.
      store.workspaceRow = {
        id: "proj-cfg",
        settings: { clientId: "p-id", clientSecret: "p-secret" },
        credentials: null,
        enabled: false,
      };
      expect(await resolveAppCredentials(WORKSPACE, app, ORG)).toEqual(
        ORG_RESOLVED,
      );
    });

    it("an incomplete workspace row falls through to the org tier", async () => {
      const seam = orgSeam();
      initOrgAppConfig(seam);
      store.workspaceRow = {
        id: "proj-cfg",
        settings: { clientId: "p-id" }, // clientSecret missing
        credentials: null,
        enabled: true,
      };
      expect(await resolveAppCredentials(WORKSPACE, app, ORG)).toEqual(
        ORG_RESOLVED,
      );
    });

    it("skips the org tier when no organizationId is passed", async () => {
      const seam = orgSeam();
      initOrgAppConfig(seam);
      process.env[ENV_VAR_ID] = "env-id";
      process.env[ENV_VAR_SECRET] = "env-secret";
      const resolved = await resolveAppCredentials(WORKSPACE, app);
      expect(resolved?.source).toBe("env");
      expect(seam.resolveCredentials).not.toHaveBeenCalled();
    });

    it("org tier returning null falls through to env", async () => {
      const seam = orgSeam();
      seam.resolveCredentials.mockResolvedValue(null);
      initOrgAppConfig(seam);
      process.env[ENV_VAR_ID] = "env-id";
      process.env[ENV_VAR_SECRET] = "env-secret";
      const resolved = await resolveAppCredentials(WORKSPACE, app, ORG);
      expect(resolved?.source).toBe("env");
    });
  });
});
