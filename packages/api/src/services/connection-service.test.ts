import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDefinition } from "../apps/types";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem-slim";
});

interface WriteData {
  appConfigId?: string | null;
  [key: string]: unknown;
}

const store = vi.hoisted(() => ({
  createData: null as WriteData | null,
  updateData: null as WriteData | null,
  updateManyArgs: null as { where: unknown; data: WriteData } | null,
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    appConnection: {
      create: async ({ data }: { data: WriteData }) => {
        store.createData = data;
        return { id: "new-conn", provider: data.provider, status: "connected" };
      },
      findFirst: async () => ({ id: "conn-1", label: "old" }),
      update: async ({ data }: { data: WriteData }) => {
        store.updateData = data;
        return { id: "conn-1", provider: "prov", status: "connected" };
      },
      updateMany: async (args: { where: unknown; data: WriteData }) => {
        store.updateManyArgs = args;
        return { count: 1 };
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

import {
  createConnection,
  reconnectConnection,
  linkConnectionToAppConfig,
  findDuplicateConnection,
} from "./connection-service";

beforeEach(() => {
  store.createData = null;
  store.updateData = null;
  store.updateManyArgs = null;
});

describe("findDuplicateConnection", () => {
  const appDef: AppDefinition = {
    id: "airbyte",
    name: "Airbyte (Self-Managed)",
    icon: "/icons/airbyte.svg",
    description: "test",
    connectionMethod: {
      type: "api_key",
      fields: [],
    },
    connectionIdentity: {
      metadataKey: "apiBaseUrl",
      normalize: "exact",
    },
    available: true,
  };

  it("matches the same self-managed endpoint by metadata identity", () => {
    const duplicate = findDuplicateConnection(
      appDef,
      [
        {
          id: "first",
          label: "production",
          metadata: { apiBaseUrl: "https://one.example/api/public/v1" },
        },
        {
          id: "second",
          label: "production",
          metadata: { apiBaseUrl: "https://two.example/api/public/v1" },
        },
      ],
      { apiBaseUrl: "https://two.example/api/public/v1" },
      "production",
    );

    expect(duplicate?.id).toBe("second");
  });

  it("does not reconnect a different endpoint merely because its label matches", () => {
    const duplicate = findDuplicateConnection(
      appDef,
      [
        {
          id: "first",
          label: "production",
          metadata: { apiBaseUrl: "https://one.example/api/public/v1" },
        },
      ],
      { apiBaseUrl: "https://two.example/api/public/v1" },
      "production",
    );

    expect(duplicate).toBeUndefined();
  });

  it("preserves label and first-connection fallback for normal providers", () => {
    const normalApp = { ...appDef, connectionIdentity: undefined };
    const existing = [
      { id: "first", label: "one", metadata: null },
      { id: "second", label: "Two", metadata: null },
    ];

    expect(
      findDuplicateConnection(normalApp, existing, undefined, " two ")?.id,
    ).toBe("second");
    expect(
      findDuplicateConnection(normalApp, existing, undefined, undefined)?.id,
    ).toBe("first");
  });
});

describe("createConnection persists provenance", () => {
  it("writes the appConfigId when provided", async () => {
    await createConnection(
      { projectId: "p-1" },
      "prov",
      { token: "t" },
      {
        appConfigId: "cfg-1",
      },
    );
    expect(store.createData?.appConfigId).toBe("cfg-1");
  });

  it("writes null when no appConfigId is given (env / no-config mint)", async () => {
    await createConnection({ projectId: "p-1" }, "prov", { token: "t" });
    expect(store.createData?.appConfigId).toBeNull();
  });
});

describe("reconnectConnection provenance is opt-in per key presence", () => {
  it("writes the appConfigId when a re-mint passes it", async () => {
    await reconnectConnection(
      { projectId: "p-1" },
      "conn-1",
      { token: "t" },
      {
        appConfigId: "cfg-2",
      },
    );
    expect(store.updateData?.appConfigId).toBe("cfg-2");
  });

  it("clears the link when a re-mint passes appConfigId: undefined", async () => {
    await reconnectConnection(
      { projectId: "p-1" },
      "conn-1",
      { token: "t" },
      {
        appConfigId: undefined,
      },
    );
    expect(store.updateData && "appConfigId" in store.updateData).toBe(true);
    expect(store.updateData?.appConfigId).toBeNull();
  });

  it("preserves the existing link when options omit the key (token-persist)", async () => {
    await reconnectConnection({ projectId: "p-1" }, "conn-1", { token: "t" });
    expect(store.updateData && "appConfigId" in store.updateData).toBe(false);
  });

  it("preserves the link when options carry other fields but not appConfigId", async () => {
    await reconnectConnection(
      { projectId: "p-1" },
      "conn-1",
      { token: "t" },
      {
        scopes: ["a"],
      },
    );
    expect(store.updateData && "appConfigId" in store.updateData).toBe(false);
  });
});

describe("linkConnectionToAppConfig", () => {
  it("writes the appConfigId under a scope-guarded where (credentials-import provenance)", async () => {
    await linkConnectionToAppConfig({ projectId: "p-1" }, "conn-1", "cfg-9");
    expect(store.updateManyArgs?.data).toEqual({ appConfigId: "cfg-9" });
    expect(store.updateManyArgs?.where).toMatchObject({
      id: "conn-1",
      projectId: "p-1",
    });
  });

  it("scopes org links by organization + scope", async () => {
    await linkConnectionToAppConfig(
      { organizationId: "org-1" },
      "conn-2",
      "cfg-3",
    );
    expect(store.updateManyArgs?.where).toMatchObject({
      id: "conn-2",
      organizationId: "org-1",
      scope: "organization",
    });
  });
});
