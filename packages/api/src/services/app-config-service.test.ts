import { beforeEach, describe, expect, it, vi } from "vitest";

// Pin the edition before any import — lib/env captures env at first load and
// CI runs the whole workflow with NEXT_PUBLIC_EDITION=cloud.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem-slim";
});

interface Conn {
  id: string;
  projectId?: string;
  organizationId?: string;
  scope: string;
  provider: string;
  appConfigId: string | null;
}

interface ConnWhere {
  organizationId?: string;
  projectId?: string;
  scope?: string;
  provider?: string;
  appConfigId?: string;
}

const store = vi.hoisted(() => ({
  // Single row returned by appConfig.findUnique (fields picked by the caller).
  appConfigRow: null as {
    id: string;
    settings: Record<string, string>;
    credentials: string | null;
    enabled: boolean;
  } | null,
  connections: [] as Conn[],
  calls: [] as string[],
  deleteManyWheres: [] as ConnWhere[],
  countWheres: [] as ConnWhere[],
}));

const matches = (conn: Conn, where: ConnWhere) =>
  (where.organizationId === undefined ||
    conn.organizationId === where.organizationId) &&
  (where.projectId === undefined || conn.projectId === where.projectId) &&
  (where.scope === undefined || conn.scope === where.scope) &&
  (where.provider === undefined || conn.provider === where.provider) &&
  (where.appConfigId === undefined || conn.appConfigId === where.appConfigId);

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    appConfig: {
      findUnique: async () => store.appConfigRow,
      delete: async () => {
        store.calls.push("configDelete");
        return store.appConfigRow;
      },
      update: async () => {
        store.calls.push("configUpdate");
        return { id: store.appConfigRow?.id, enabled: false };
      },
    },
    appConnection: {
      deleteMany: async ({ where }: { where: ConnWhere }) => {
        store.calls.push("deleteMany");
        store.deleteManyWheres.push(where);
        const before = store.connections.length;
        store.connections = store.connections.filter((c) => !matches(c, where));
        return { count: before - store.connections.length };
      },
      count: async ({ where }: { where: ConnWhere }) => {
        store.countWheres.push(where);
        return store.connections.filter((c) => matches(c, where)).length;
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

import {
  deleteAppConfig,
  toggleAppConfigEnabled,
  countAppConfigDependents,
  getAppConfigCredentials,
  hasAppConfig,
} from "./app-config-service";

const seedConfig = (id = "cfg-1") => {
  store.appConfigRow = {
    id,
    settings: { clientId: "cid" },
    credentials: null,
    enabled: true,
  };
};

beforeEach(() => {
  store.appConfigRow = null;
  store.connections = [];
  store.calls = [];
  store.deleteManyWheres = [];
  store.countWheres = [];
});

describe("disconnectIfConnected via deleteAppConfig — org scope", () => {
  beforeEach(() => {
    seedConfig();
    store.connections = [
      // the config's own org-scoped connection
      {
        id: "org-conn",
        organizationId: "org-1",
        scope: "organization",
        provider: "prov",
        appConfigId: "cfg-1",
      },
      // a project connection this config minted (provenance link)
      {
        id: "proj-linked",
        projectId: "p-1",
        scope: "project",
        provider: "prov",
        appConfigId: "cfg-1",
      },
      // a project connection with NO link (env-minted / legacy) — must survive
      {
        id: "proj-unlinked",
        projectId: "p-2",
        scope: "project",
        provider: "prov",
        appConfigId: null,
      },
      // a project connection minted by a DIFFERENT config — must survive
      {
        id: "proj-other",
        projectId: "p-3",
        scope: "project",
        provider: "prov",
        appConfigId: "cfg-2",
      },
    ];
  });

  it("disconnects the org-scoped row and exactly the linked project rows", async () => {
    await deleteAppConfig({ organizationId: "org-1" }, "prov");

    const survivors = store.connections.map((c) => c.id).sort();
    expect(survivors).toEqual(["proj-other", "proj-unlinked"]);
  });

  it("runs the wholesale org delete then the FK sweep with the right predicates", async () => {
    await deleteAppConfig({ organizationId: "org-1" }, "prov");

    expect(store.deleteManyWheres[0]).toEqual({
      organizationId: "org-1",
      scope: "organization",
      provider: "prov",
    });
    expect(store.deleteManyWheres[1]).toEqual({
      appConfigId: "cfg-1",
      scope: "project",
    });
  });

  it("disconnects BEFORE deleting the config row (SetNull would blind the sweep)", async () => {
    await deleteAppConfig({ organizationId: "org-1" }, "prov");

    expect(store.calls).toEqual(["deleteMany", "deleteMany", "configDelete"]);
  });
});

describe("disconnectIfConnected via deleteAppConfig — project scope stays blunt", () => {
  it("deletes all provider connections in the project and runs NO org FK sweep", async () => {
    seedConfig();
    store.connections = [
      {
        id: "p-conn",
        projectId: "p-1",
        scope: "project",
        provider: "prov",
        appConfigId: "cfg-1",
      },
    ];

    await deleteAppConfig({ projectId: "p-1" }, "prov");

    expect(store.deleteManyWheres).toEqual([
      { projectId: "p-1", provider: "prov" },
    ]);
    expect(store.calls).toEqual(["deleteMany", "configDelete"]);
  });
});

describe("toggleAppConfigEnabled — org scope disconnects before writing", () => {
  it("sweeps org + linked project rows, then updates", async () => {
    seedConfig();
    store.connections = [
      {
        id: "org-conn",
        organizationId: "org-1",
        scope: "organization",
        provider: "prov",
        appConfigId: "cfg-1",
      },
      {
        id: "proj-linked",
        projectId: "p-1",
        scope: "project",
        provider: "prov",
        appConfigId: "cfg-1",
      },
    ];

    await toggleAppConfigEnabled({ organizationId: "org-1" }, "prov", false);

    expect(store.calls).toEqual(["deleteMany", "deleteMany", "configUpdate"]);
    expect(store.connections).toHaveLength(0);
  });
});

describe("countAppConfigDependents", () => {
  it("counts org-scoped connections and linked project connections", async () => {
    seedConfig();
    store.connections = [
      {
        id: "org-a",
        organizationId: "org-1",
        scope: "organization",
        provider: "prov",
        appConfigId: "cfg-1",
      },
      {
        id: "org-b",
        organizationId: "org-1",
        scope: "organization",
        provider: "prov",
        appConfigId: "cfg-1",
      },
      {
        id: "proj-a",
        projectId: "p-1",
        scope: "project",
        provider: "prov",
        appConfigId: "cfg-1",
      },
      // unlinked + different-config project rows must not be counted
      {
        id: "proj-x",
        projectId: "p-2",
        scope: "project",
        provider: "prov",
        appConfigId: null,
      },
    ];

    const dependents = await countAppConfigDependents(
      { organizationId: "org-1" },
      "prov",
    );

    expect(dependents).toEqual({ orgConnections: 2, projectConnections: 1 });
    expect(store.countWheres).toContainEqual({
      organizationId: "org-1",
      scope: "organization",
      provider: "prov",
    });
    expect(store.countWheres).toContainEqual({
      appConfigId: "cfg-1",
      scope: "project",
    });
  });

  it("reports zero project dependents when there is no config row", async () => {
    store.appConfigRow = null;
    store.connections = [];

    const dependents = await countAppConfigDependents(
      { organizationId: "org-1" },
      "prov",
    );

    expect(dependents).toEqual({ orgConnections: 0, projectConnections: 0 });
  });
});

describe("hasAppConfig — configured means usable (enabled + credentials)", () => {
  it("true only when the row is enabled AND carries credentials", async () => {
    store.appConfigRow = {
      id: "c",
      settings: { clientId: "x" },
      credentials: "enc:secret",
      enabled: true,
    };
    expect(await hasAppConfig({ organizationId: "org-1" }, "prov")).toBe(true);
  });

  it("false when enabled but credentials are missing (half-saved config)", async () => {
    store.appConfigRow = {
      id: "c",
      settings: { clientId: "x" },
      credentials: null,
      enabled: true,
    };
    expect(await hasAppConfig({ organizationId: "org-1" }, "prov")).toBe(false);
  });

  it("false when the row is disabled", async () => {
    store.appConfigRow = {
      id: "c",
      settings: { clientId: "x" },
      credentials: "enc:secret",
      enabled: false,
    };
    expect(await hasAppConfig({ projectId: "p-1" }, "prov")).toBe(false);
  });
});

describe("getAppConfigCredentials reshape", () => {
  it("returns the serving row id alongside its fields", async () => {
    store.appConfigRow = {
      id: "cfg-9",
      settings: { clientId: "cid" },
      credentials: null,
      enabled: true,
    };

    expect(await getAppConfigCredentials({ projectId: "p" }, "prov")).toEqual({
      appConfigId: "cfg-9",
      fields: { clientId: "cid" },
    });
  });

  it("returns null for a disabled row", async () => {
    store.appConfigRow = {
      id: "cfg-9",
      settings: { clientId: "cid" },
      credentials: null,
      enabled: false,
    };

    expect(
      await getAppConfigCredentials({ projectId: "p" }, "prov"),
    ).toBeNull();
  });
});
