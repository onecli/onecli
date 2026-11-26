import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  workspaceId: "ws-own",
  organizationId: "org-own",
  where: [] as unknown[],
  row: null as { label: string | null; metadata: unknown } | null,
}));

vi.mock("@/lib/actions/resolve-user", () => ({
  resolveWorkspaceContext: async () => ({ workspaceId: state.workspaceId }),
  resolveOrgContext: async () => ({ organizationId: state.organizationId }),
}));

vi.mock("@onecli/db", () => ({
  db: {
    appConnection: {
      findFirst: async ({ where }: { where: unknown }) => {
        state.where.push(where);
        return state.row;
      },
    },
  },
}));

const { getReconnectPrefill } = await import("./reconnect-prefill");

const target = {
  host: "db.example.com",
  port: 6543,
  database: "orders",
  username: "agent",
};

beforeEach(() => {
  state.where = [];
  state.row = null;
});

describe("getReconnectPrefill", () => {
  it("reads only the caller's own workspace connection", async () => {
    await getReconnectPrefill("postgres", "pg-1");
    expect(state.where).toEqual([
      { id: "pg-1", workspaceId: "ws-own", provider: "postgres" },
    ]);
  });

  it("reads only an org-scoped connection of the caller's org", async () => {
    await getReconnectPrefill("postgres", "pg-1", "org-from-the-url");
    // The org comes from the resolved membership, never from the URL.
    expect(state.where).toEqual([
      {
        id: "pg-1",
        organizationId: "org-own",
        scope: "organization",
        provider: "postgres",
      },
    ]);
  });

  it("is null for a connection outside the fence", async () => {
    expect(await getReconnectPrefill("postgres", "pg-foreign")).toBeNull();
  });

  it("starts from the recorded target and TLS mode, never a secret", async () => {
    state.row = {
      label: "orders",
      metadata: { name: "orders", target, tags: ["No TLS"] },
    };
    expect(await getReconnectPrefill("postgres", "pg-1")).toEqual({
      // The generated name is left out, so a reconnect regenerates it.
      label: null,
      fields: {
        host: "db.example.com",
        port: "6543",
        database: "orders",
        username: "agent",
        sslmode: "disable",
      },
    });
  });

  it("keeps a name the user chose and reads an older connection's name", async () => {
    state.row = {
      label: "Orders (prod)",
      metadata: { name: "orders on db.example.com", tags: ["TLS verified"] },
    };
    expect(await getReconnectPrefill("postgres", "pg-1")).toEqual({
      label: "Orders (prod)",
      fields: {
        host: "db.example.com",
        database: "orders",
        sslmode: "verify-full",
      },
    });
  });
});
