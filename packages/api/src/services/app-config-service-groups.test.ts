import { beforeEach, describe, expect, it, vi } from "vitest";

// Vendor-group writes: saving on any Google app stores ONE `google` row,
// sweeps every Google app's connections in that scope (their tokens are bound
// to the client being replaced), and removes superseded legacy per-app rows,
// including, at org scope, the workspace connections those legacy rows
// minted, before SetNull would orphan them.

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

type Where = Record<string, unknown>;

const store = vi.hoisted(() => ({
  configs: [] as {
    id: string;
    key: string;
    provider: string;
    credentials?: string | null;
  }[],
  upserts: [] as {
    where: Where;
    create: { provider: string; credentials: string | null };
  }[],
  connDeletes: [] as Where[],
  configDeletes: [] as Where[],
  calls: [] as string[],
}));

const keyOf = (where: Where) => {
  const w = (where.organizationId_provider ?? where.workspaceId_provider) as {
    organizationId?: string;
    workspaceId?: string;
    provider: string;
  };
  return `${w.organizationId ?? w.workspaceId}:${w.provider}`;
};

const inProviders = (where: Where) =>
  (where.provider as { in?: string[] } | undefined)?.in ?? [];

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    appConfig: {
      findUnique: async ({ where }: { where: Where }) => {
        const row = store.configs.find((c) => c.key === keyOf(where));
        return row
          ? { id: row.id, credentials: row.credentials ?? null }
          : null;
      },
      findMany: async ({ where }: { where: Where }) =>
        store.configs
          .filter((c) => inProviders(where).includes(c.provider))
          .map((c) => ({ id: c.id })),
      deleteMany: async ({ where }: { where: Where }) => {
        store.calls.push("configDeleteMany");
        store.configDeletes.push(where);
        return { count: 0 };
      },
      upsert: async (args: {
        where: Where;
        create: { provider: string; credentials: string | null };
      }) => {
        store.calls.push("upsert");
        store.upserts.push(args);
        return { id: "new", provider: args.create.provider };
      },
    },
    appConnection: {
      // No platform-minted connections in these cases (covered by the pg proof).
      findMany: async () => [],
      deleteMany: async ({ where }: { where: Where }) => {
        store.calls.push("connDeleteMany");
        store.connDeletes.push(where);
        return { count: 0 };
      },
    },
  },
}));

vi.mock("../providers", () => ({
  getCrypto: () => ({ encrypt: async (s: string) => `enc:${s}` }),
}));

import { upsertAppConfig, listConfiguredProviders } from "./app-config-service";
import { googleConfigFields } from "../apps/oauth/google";
import { groupMembers } from "../apps/oauth/groups";

const values = { clientId: "cid", clientSecret: "sec" };

beforeEach(() => {
  store.configs = [];
  store.upserts = [];
  store.connDeletes = [];
  store.configDeletes = [];
  store.calls = [];
});

describe("upsertAppConfig on a grouped app", () => {
  it("saving on Gmail at workspace scope writes one `google` row", async () => {
    await upsertAppConfig(
      { workspaceId: "ws-1" },
      "gmail",
      values,
      googleConfigFields,
    );
    expect(store.upserts).toHaveLength(1);
    expect(store.upserts[0]!.create.provider).toBe("google");
    expect(keyOf(store.upserts[0]!.where)).toBe("ws-1:google");
  });

  it("sweeps every Google app's connections in that scope, not just Gmail's", async () => {
    await upsertAppConfig(
      { workspaceId: "ws-1" },
      "google-drive",
      values,
      googleConfigFields,
    );
    expect(store.connDeletes[0]).toEqual({
      workspaceId: "ws-1",
      provider: { in: groupMembers("google") },
    });
  });

  it("removes superseded legacy per-app rows in the same scope", async () => {
    await upsertAppConfig(
      { workspaceId: "ws-1" },
      "gmail",
      values,
      googleConfigFields,
    );
    expect(store.configDeletes).toEqual([
      { workspaceId: "ws-1", provider: { in: groupMembers("google") } },
    ]);
  });

  it("at org scope, drops workspace connections minted by legacy org rows before deleting them", async () => {
    store.configs = [
      { id: "legacy-gmail", key: "org-1:gmail", provider: "gmail" },
    ];
    await upsertAppConfig(
      { organizationId: "org-1" },
      "gmail",
      values,
      googleConfigFields,
    );
    expect(store.connDeletes).toContainEqual({
      appConfigId: { in: ["legacy-gmail"] },
      scope: "workspace",
    });
    const sweep = store.calls.lastIndexOf("connDeleteMany");
    expect(sweep).toBeLessThan(store.calls.indexOf("configDeleteMany"));
    expect(store.calls.at(-1)).toBe("upsert");
  });

  // The form says "Leave empty to keep current" under a saved secret. For an
  // app still on its pre-grouping per-app row, "current" is THAT row's
  // secret, and the save replaces the row with the group row: the secret has
  // to carry over, or the new vendor client would be saved without one.
  it("keeps a legacy per-app row's secret when the save leaves it empty", async () => {
    store.configs = [
      {
        id: "legacy-gmail",
        key: "ws-1:gmail",
        provider: "gmail",
        credentials: "enc:legacy-secret",
      },
    ];
    await upsertAppConfig(
      { workspaceId: "ws-1" },
      "gmail",
      { clientId: "cid", clientSecret: "" },
      googleConfigFields,
    );
    expect(store.upserts[0]!.create).toMatchObject({
      provider: "google",
      credentials: "enc:legacy-secret",
    });
  });

  it("keeps the group row's own secret over a legacy row's", async () => {
    store.configs = [
      {
        id: "group",
        key: "ws-1:google",
        provider: "google",
        credentials: "enc:group-secret",
      },
      {
        id: "legacy-gmail",
        key: "ws-1:gmail",
        provider: "gmail",
        credentials: "enc:legacy-secret",
      },
    ];
    await upsertAppConfig(
      { workspaceId: "ws-1" },
      "gmail",
      { clientId: "cid", clientSecret: "" },
      googleConfigFields,
    );
    expect(store.upserts[0]!.create.credentials).toBe("enc:group-secret");
  });
});

describe("listConfiguredProviders", () => {
  it("expands a group row to its member apps", async () => {
    const { db } = await import("@onecli/db");
    (db.appConfig as unknown as { findMany: unknown }).findMany = async () => [
      { provider: "atlassian" },
      { provider: "github" },
    ];
    expect(
      (await listConfiguredProviders({ workspaceId: "ws-1" })).sort(),
    ).toEqual(["confluence", "github", "jira"]);
  });
});
