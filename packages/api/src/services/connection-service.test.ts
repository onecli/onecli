import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

interface WriteData {
  appConfigId?: string | null;
  [key: string]: unknown;
}

const store = vi.hoisted(() => ({
  createData: null as WriteData | null,
  updateData: null as WriteData | null,
  updateManyArgs: null as { where: unknown; data: WriteData } | null,
  existingProvider: "prov",
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    appConnection: {
      create: async ({ data }: { data: WriteData }) => {
        store.createData = data;
        return { id: "new-conn", provider: data.provider, status: "connected" };
      },
      findFirst: async () => ({
        id: "conn-1",
        label: "old",
        provider: store.existingProvider,
      }),
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

const bumps = vi.hoisted(() => ({ workspace: [] as string[] }));
vi.mock("./home-sync-service", () => ({
  bumpHomeForScope: async (scope: { workspaceId?: string }) => {
    if (scope.workspaceId) bumps.workspace.push(scope.workspaceId);
  },
}));

import {
  createConnection,
  reconnectConnection,
  linkConnectionToAppConfig,
} from "./connection-service";

beforeEach(() => {
  store.createData = null;
  store.updateData = null;
  store.updateManyArgs = null;
  store.existingProvider = "prov";
});

describe("bound_host is recorded from the gated credential field", () => {
  it("create: every host-bound provider gets metadata.bound_host", async () => {
    for (const [provider, creds, host] of [
      [
        "salesforce",
        { instance_host: "acme.my.salesforce.com" },
        "acme.my.salesforce.com",
      ],
      [
        "snowflake",
        { host: "https://Acme-Prod.snowflakecomputing.com/" },
        "acme-prod.snowflakecomputing.com",
      ],
      ["jfrog-artifactory", { subdomain: "acme.jfrog.io" }, "acme.jfrog.io"],
    ] as const) {
      await createConnection({ workspaceId: "p-1" }, provider, creds, {
        metadata: { name: "x" },
      });
      expect(store.createData?.metadata).toEqual({
        name: "x",
        bound_host: host,
      });
    }
  });

  it("create: a caller cannot plant a bound_host the credential does not back", async () => {
    await createConnection(
      { workspaceId: "p-1" },
      "snowflake",
      { host: "acme.snowflakecomputing.com" },
      { metadata: { bound_host: "evil.snowflakecomputing.com" } },
    );
    expect(store.createData?.metadata).toEqual({
      bound_host: "acme.snowflakecomputing.com",
    });
    // No backing credential at all: the planted key is dropped, not kept.
    await createConnection(
      { workspaceId: "p-1" },
      "github",
      { access_token: "t" },
      { metadata: { name: "x", bound_host: "evil.snowflakecomputing.com" } },
    );
    expect(store.createData?.metadata).toEqual({ name: "x" });
  });

  it("create: out-of-zone or unknown providers record nothing", async () => {
    await createConnection(
      { workspaceId: "p-1" },
      "snowflake",
      { host: "evil.test" },
      { metadata: { name: "x" } },
    );
    expect(store.createData?.metadata).toEqual({ name: "x" });
    await createConnection(
      { workspaceId: "p-1" },
      "github",
      { host: "acme.snowflakecomputing.com" },
      { metadata: { name: "x" } },
    );
    expect(store.createData?.metadata).toEqual({ name: "x" });
  });

  it("reconnect: a re-auth re-derives it from the stored provider", async () => {
    store.existingProvider = "salesforce";
    await reconnectConnection(
      { workspaceId: "p-1" },
      "conn-1",
      { instance_host: "other.my.salesforce.com" },
      { metadata: { username: "u" } },
    );
    expect(store.updateData?.metadata).toEqual({
      username: "u",
      bound_host: "other.my.salesforce.com",
    });
  });

  it("reconnect: a bare token persist leaves metadata untouched", async () => {
    store.existingProvider = "salesforce";
    await reconnectConnection({ workspaceId: "p-1" }, "conn-1", {
      instance_host: "acme.my.salesforce.com",
    });
    expect(store.updateData?.metadata).toBeUndefined();
  });
});

describe("createConnection persists provenance", () => {
  it("writes the appConfigId when provided", async () => {
    await createConnection(
      { workspaceId: "p-1" },
      "prov",
      { token: "t" },
      {
        appConfigId: "cfg-1",
      },
    );
    expect(store.createData?.appConfigId).toBe("cfg-1");
  });

  it("writes null when no appConfigId is given (env / no-config mint)", async () => {
    await createConnection({ workspaceId: "p-1" }, "prov", { token: "t" });
    expect(store.createData?.appConfigId).toBeNull();
  });

  it("re-renders the workspace's agent homes (their connected-apps list changed)", async () => {
    bumps.workspace.length = 0;
    await createConnection({ workspaceId: "p-1" }, "prov", { token: "t" });
    expect(bumps.workspace).toEqual(["p-1"]);
  });
});

describe("home refresh follows what the agent reads", () => {
  it("a bare token refresh (no metadata) does NOT re-render homes", async () => {
    bumps.workspace.length = 0;
    await reconnectConnection({ workspaceId: "p-1" }, "conn-1", { t: 1 });
    expect(bumps.workspace).toEqual([]);
  });

  it("a re-auth carrying metadata (possibly a new bound host) does", async () => {
    bumps.workspace.length = 0;
    await reconnectConnection(
      { workspaceId: "p-1" },
      "conn-1",
      { t: 1 },
      { metadata: { username: "u" } },
    );
    expect(bumps.workspace).toEqual(["p-1"]);
  });
});

describe("reconnectConnection provenance is opt-in per key presence", () => {
  it("writes the appConfigId when a re-mint passes it", async () => {
    await reconnectConnection(
      { workspaceId: "p-1" },
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
      { workspaceId: "p-1" },
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
    await reconnectConnection({ workspaceId: "p-1" }, "conn-1", { token: "t" });
    expect(store.updateData && "appConfigId" in store.updateData).toBe(false);
  });

  it("preserves the link when options carry other fields but not appConfigId", async () => {
    await reconnectConnection(
      { workspaceId: "p-1" },
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
    await linkConnectionToAppConfig({ workspaceId: "p-1" }, "conn-1", "cfg-9");
    expect(store.updateManyArgs?.data).toEqual({ appConfigId: "cfg-9" });
    expect(store.updateManyArgs?.where).toMatchObject({
      id: "conn-1",
      workspaceId: "p-1",
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
