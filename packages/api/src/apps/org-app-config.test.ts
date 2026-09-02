import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

const store = vi.hoisted(() => ({
  row: null as {
    settings: Record<string, string>;
    credentials: string | null;
    enabled: boolean;
  } | null,
  findManyRows: [] as { provider: string }[],
  findManyWhere: null as Record<string, unknown> | null,
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    appConfig: {
      findUnique: async () => store.row,
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        store.findManyWhere = where;
        return store.findManyRows;
      },
    },
  },
}));

vi.mock("../providers", () => ({
  getCrypto: () => ({
    encrypt: async (s: string) => `enc:${s}`,
    decrypt: async (s: string) => s.slice(4),
  }),
}));

import { orgAppConfig } from "./org-app-config";

beforeEach(() => {
  store.row = null;
  store.findManyRows = [];
  store.findManyWhere = null;
});

describe("orgAppConfig.getEnabledConfig — only a usable config counts", () => {
  it("returns the config when enabled AND credentialed", async () => {
    store.row = {
      settings: { clientId: "x" },
      credentials: "enc:secret",
      enabled: true,
    };
    expect(await orgAppConfig.getEnabledConfig("org-1", "prov")).toEqual({
      hasCredentials: true,
    });
  });

  it("returns null when enabled but credentials are missing (half-saved)", async () => {
    store.row = {
      settings: { clientId: "x" },
      credentials: null,
      enabled: true,
    };
    expect(await orgAppConfig.getEnabledConfig("org-1", "prov")).toBeNull();
  });

  it("returns null when the row is disabled", async () => {
    store.row = {
      settings: { clientId: "x" },
      credentials: "enc:secret",
      enabled: false,
    };
    expect(await orgAppConfig.getEnabledConfig("org-1", "prov")).toBeNull();
  });
});

describe("orgAppConfig.listEnabledConfigs — filters to credentialed rows", () => {
  it("queries only enabled rows that carry credentials", async () => {
    store.findManyRows = [{ provider: "aaa" }, { provider: "bbb" }];

    const result = await orgAppConfig.listEnabledConfigs("org-1");

    expect(result).toEqual({
      aaa: { hasCredentials: true },
      bbb: { hasCredentials: true },
    });
    expect(store.findManyWhere).toMatchObject({
      organizationId: "org-1",
      scope: "organization",
      enabled: true,
      credentials: { not: null },
    });
  });
});
