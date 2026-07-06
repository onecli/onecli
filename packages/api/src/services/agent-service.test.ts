import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory `@onecli/db` mock covering only what listConnectionAgents /
// setConnectionAgents touch, so the reverse-view classification and the
// diff-based write can be asserted without a database.

interface AgentRow {
  id: string;
  name: string;
  projectId: string;
  secretMode: string;
  isDefault: boolean;
  createdAt: Date;
}

interface ConnectionRow {
  id: string;
  projectId: string | null;
  organizationId: string | null;
  scope: string | null;
}

interface JoinRow {
  agentId: string;
  appConnectionId: string;
  sessionPolicy: unknown;
}

const store = vi.hoisted(() => ({
  projects: [] as { id: string; organizationId: string | null }[],
  connections: [] as ConnectionRow[],
  agents: [] as AgentRow[],
  rows: [] as JoinRow[],
  txCount: 0,
}));

// getPolicyValidator is only reached by updateAgentAppConnections (untested
// here); stub it so importing the service doesn't pull the provider registry.
vi.mock("../providers/hooks/policy-validator", () => ({
  getPolicyValidator: () => ({ validate: async () => {} }),
}));

vi.mock("@onecli/db", () => {
  const project = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const p = store.projects.find((row) => row.id === where.id);
      return p ? { organizationId: p.organizationId } : null;
    },
  };

  interface ConnWhere {
    id: string;
    OR: ({ projectId: string } | { organizationId: string; scope: string })[];
  }
  const appConnection = {
    findFirst: async ({ where }: { where: ConnWhere }) => {
      const conn = store.connections.find((c) => {
        if (c.id !== where.id) return false;
        return where.OR.some((branch) =>
          "projectId" in branch
            ? c.projectId === branch.projectId
            : c.organizationId === branch.organizationId &&
              c.scope === branch.scope,
        );
      });
      return conn ? { id: conn.id } : null;
    },
  };

  const agent = {
    findMany: async ({
      where,
    }: {
      where: { projectId?: string; id?: { in: string[] } };
    }) => {
      let list = store.agents.slice();
      if (where.projectId !== undefined)
        list = list.filter((a) => a.projectId === where.projectId);
      if (where.id?.in) {
        const ids = new Set(where.id.in);
        list = list.filter((a) => ids.has(a.id));
      }
      list.sort(
        (a, b) =>
          Number(b.isDefault) - Number(a.isDefault) ||
          b.createdAt.getTime() - a.createdAt.getTime(),
      );
      return list.map((a) => ({
        id: a.id,
        name: a.name,
        secretMode: a.secretMode,
      }));
    },
  };

  interface JoinWhere {
    appConnectionId: string;
    agent?: { projectId?: string; secretMode?: string };
    agentId?: { in: string[] };
  }
  const agentAppConnection = {
    findMany: async ({ where }: { where: JoinWhere }) =>
      store.rows
        .filter((r) => {
          if (r.appConnectionId !== where.appConnectionId) return false;
          if (where.agent) {
            const ag = store.agents.find((a) => a.id === r.agentId);
            if (!ag) return false;
            if (
              where.agent.projectId !== undefined &&
              ag.projectId !== where.agent.projectId
            )
              return false;
            if (
              where.agent.secretMode !== undefined &&
              ag.secretMode !== where.agent.secretMode
            )
              return false;
          }
          return true;
        })
        .map((r) => ({ agentId: r.agentId, sessionPolicy: r.sessionPolicy })),
    deleteMany: async ({ where }: { where: JoinWhere }) => {
      const ids = new Set(where.agentId?.in ?? []);
      const before = store.rows.length;
      store.rows = store.rows.filter(
        (r) =>
          !(r.appConnectionId === where.appConnectionId && ids.has(r.agentId)),
      );
      return { count: before - store.rows.length };
    },
    createMany: async ({
      data,
    }: {
      data: { agentId: string; appConnectionId: string }[];
    }) => {
      let count = 0;
      for (const d of data) {
        const exists = store.rows.some(
          (r) =>
            r.agentId === d.agentId && r.appConnectionId === d.appConnectionId,
        );
        if (exists) continue; // skipDuplicates
        store.rows.push({
          agentId: d.agentId,
          appConnectionId: d.appConnectionId,
          sessionPolicy: null,
        });
        count++;
      }
      return { count };
    },
  };

  const db = {
    project,
    appConnection,
    agent,
    agentAppConnection,
    $transaction: async (ops: Promise<unknown>[]) => {
      store.txCount++;
      return Promise.all(ops);
    },
  };

  return {
    db,
    Prisma: { DbNull: Symbol("DbNull"), JsonNull: Symbol("JsonNull") },
  };
});

import { listConnectionAgents, setConnectionAgents } from "./agent-service";

const seedAgent = (over: Partial<AgentRow> & { id: string }): void => {
  store.agents.push({
    name: over.id,
    projectId: "p1",
    secretMode: "all",
    isDefault: false,
    createdAt: new Date("2026-01-01"),
    ...over,
  });
};

const rowKeys = () =>
  store.rows.map((r) => `${r.agentId}:${r.appConnectionId}`).sort();

beforeEach(() => {
  store.projects = [{ id: "p1", organizationId: "o1" }];
  store.connections = [
    { id: "c1", projectId: "p1", organizationId: null, scope: "project" },
  ];
  store.agents = [];
  store.rows = [];
  store.txCount = 0;
});

describe("listConnectionAgents", () => {
  it("classifies full / assigned / none", async () => {
    seedAgent({ id: "a1", secretMode: "all" });
    seedAgent({ id: "a2", secretMode: "selective" });
    seedAgent({ id: "a3", secretMode: "selective" });
    store.rows.push({
      agentId: "a2",
      appConnectionId: "c1",
      sessionPolicy: null,
    });

    const result = await listConnectionAgents("p1", "c1");

    expect(result).toEqual(
      expect.arrayContaining([
        { id: "a1", name: "a1", access: "full", scoped: false },
        { id: "a2", name: "a2", access: "assigned", scoped: false },
        { id: "a3", name: "a3", access: "none", scoped: false },
      ]),
    );
    expect(result).toHaveLength(3);
  });

  it("marks an assigned agent with a granular policy as scoped", async () => {
    seedAgent({ id: "a1", secretMode: "selective" });
    seedAgent({ id: "a2", secretMode: "selective" });
    store.rows.push(
      { agentId: "a1", appConnectionId: "c1", sessionPolicy: { repo: "x" } },
      { agentId: "a2", appConnectionId: "c1", sessionPolicy: null },
    );

    const result = await listConnectionAgents("p1", "c1");

    expect(result).toEqual(
      expect.arrayContaining([
        { id: "a1", name: "a1", access: "assigned", scoped: true },
        { id: "a2", name: "a2", access: "assigned", scoped: false },
      ]),
    );
  });

  it("throws NOT_FOUND for a connection the project can't see", async () => {
    store.connections = [
      { id: "c9", projectId: "other", organizationId: null, scope: "project" },
    ];
    await expect(listConnectionAgents("p1", "c9")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("resolves an org-scoped connection in the project's org", async () => {
    store.connections = [
      {
        id: "cOrg",
        projectId: null,
        organizationId: "o1",
        scope: "organization",
      },
    ];
    seedAgent({ id: "a1", secretMode: "all" });

    const result = await listConnectionAgents("p1", "cOrg");
    expect(result).toEqual([
      { id: "a1", name: "a1", access: "full", scoped: false },
    ]);
  });
});

describe("setConnectionAgents", () => {
  it("adds newly-selected selective agents", async () => {
    seedAgent({ id: "a1", secretMode: "selective" });
    seedAgent({ id: "a2", secretMode: "selective" });

    const result = await setConnectionAgents("p1", "c1", ["a1", "a2"]);

    expect(result).toEqual({ added: 2, removed: 0 });
    expect(rowKeys()).toEqual(["a1:c1", "a2:c1"]);
  });

  it("removes de-selected selective agents", async () => {
    seedAgent({ id: "a1", secretMode: "selective" });
    seedAgent({ id: "a2", secretMode: "selective" });
    store.rows.push(
      { agentId: "a1", appConnectionId: "c1", sessionPolicy: null },
      { agentId: "a2", appConnectionId: "c1", sessionPolicy: null },
    );

    const result = await setConnectionAgents("p1", "c1", ["a1"]);

    expect(result).toEqual({ added: 0, removed: 1 });
    expect(rowKeys()).toEqual(["a1:c1"]);
  });

  it("preserves unchanged rows (policy + other connections) and touches only this connection", async () => {
    seedAgent({ id: "a1", secretMode: "selective" });
    seedAgent({ id: "a2", secretMode: "selective" });
    store.rows.push(
      { agentId: "a1", appConnectionId: "c1", sessionPolicy: { repo: "x" } },
      { agentId: "a1", appConnectionId: "c2", sessionPolicy: null },
    );

    const result = await setConnectionAgents("p1", "c1", ["a1", "a2"]);

    expect(result).toEqual({ added: 1, removed: 0 });
    expect(rowKeys()).toEqual(["a1:c1", "a1:c2", "a2:c1"]);
    // a1's existing c1 row was not deleted+recreated, so its policy survives.
    const a1c1 = store.rows.find(
      (r) => r.agentId === "a1" && r.appConnectionId === "c1",
    );
    expect(a1c1?.sessionPolicy).toEqual({ repo: "x" });
  });

  it("rejects an all-mode agent as a target", async () => {
    seedAgent({ id: "a1", secretMode: "all" });
    await expect(setConnectionAgents("p1", "c1", ["a1"])).rejects.toMatchObject(
      { code: "BAD_REQUEST" },
    );
    expect(store.txCount).toBe(0);
  });

  it("rejects an agent outside the project", async () => {
    seedAgent({ id: "aX", secretMode: "selective", projectId: "other" });
    await expect(setConnectionAgents("p1", "c1", ["aX"])).rejects.toMatchObject(
      { code: "BAD_REQUEST" },
    );
  });

  it("throws NOT_FOUND for a connection the project can't see", async () => {
    seedAgent({ id: "a1", secretMode: "selective" });
    await expect(setConnectionAgents("p1", "c9", ["a1"])).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
  });

  it("is a no-op (no transaction) when the target equals the current set", async () => {
    seedAgent({ id: "a1", secretMode: "selective" });
    store.rows.push({
      agentId: "a1",
      appConnectionId: "c1",
      sessionPolicy: null,
    });

    const result = await setConnectionAgents("p1", "c1", ["a1"]);

    expect(result).toEqual({ added: 0, removed: 0 });
    expect(store.txCount).toBe(0);
    expect(rowKeys()).toEqual(["a1:c1"]);
  });
});
