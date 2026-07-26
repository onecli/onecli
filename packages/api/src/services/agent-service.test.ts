import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory `@onecli/db` mock covering only what `createAgent` touches. The
// load-bearing case is the secret-mode inheritance: since step 10 the per-agent
// grant tables are frozen, so a sub-agent can only inherit its parent's MODE —
// inheriting "selective" must leave it with nothing until a policy rule grants
// it (fail-closed), and must never silently widen to "all".

interface AgentRow {
  id: string;
  projectId: string;
  identifier: string;
  name: string;
  secretMode: string;
}

const store = vi.hoisted(() => ({
  agents: [] as AgentRow[],
  created: [] as Record<string, unknown>[],
  createThrows: null as Error | null,
}));

vi.mock("@onecli/db", () => {
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, params: { code: string }) {
      super(message);
      this.code = params.code;
    }
  }
  return {
    Prisma: { PrismaClientKnownRequestError },
    db: {
      agent: {
        findFirst: async ({
          where,
        }: {
          where: { projectId: string; identifier: string };
        }) =>
          store.agents.find(
            (a) =>
              a.projectId === where.projectId &&
              a.identifier === where.identifier,
          ) ?? null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          if (store.createThrows) throw store.createThrows;
          store.created.push(data);
          return {
            id: "new-agent",
            name: data.name,
            identifier: data.identifier,
            createdAt: new Date(0),
          };
        },
      },
    },
  };
});

const { createAgent } = await import("./agent-service");
const { Prisma } = await import("@onecli/db");

const seedParent = (identifier: string, secretMode: string) => {
  store.agents.push({
    id: `id-${identifier}`,
    projectId: "p1",
    identifier,
    name: identifier,
    secretMode,
  });
};

const lastCreated = () => store.created.at(-1)!;

beforeEach(() => {
  store.agents = [];
  store.created = [];
  store.createThrows = null;
});

describe("createAgent — secret-mode inheritance", () => {
  it("defaults to all-mode with no parent", async () => {
    await createAgent("p1", "Solo", "solo");
    expect(lastCreated().secretMode).toBe("all");
  });

  it("inherits a selective parent's mode — the child starts fail-closed", async () => {
    seedParent("parent", "selective");
    await createAgent("p1", "Child", "child", "parent");
    // Selective + no grants = injects nothing until a policy rule says otherwise.
    // Widening this to "all" would hand the child its parent's whole pool.
    expect(lastCreated().secretMode).toBe("selective");
  });

  it("inherits an all-mode parent's mode", async () => {
    seedParent("parent", "all");
    await createAgent("p1", "Child", "child", "parent");
    expect(lastCreated().secretMode).toBe("all");
  });

  it("a parent in ANOTHER project is not inherited from", async () => {
    store.agents.push({
      id: "foreign",
      projectId: "p2",
      identifier: "parent",
      name: "parent",
      secretMode: "selective",
    });
    await createAgent("p1", "Child", "child", "parent");
    expect(lastCreated().secretMode).toBe("all");
  });

  it("an unresolvable parent identifier falls back to all-mode", async () => {
    // Documented consequence of a typo'd parent: the child is NOT restricted.
    // Pinned so a future change to fail-closed here is a deliberate one.
    await createAgent("p1", "Child", "child", "no-such-parent");
    expect(lastCreated().secretMode).toBe("all");
  });
});

describe("createAgent — validation", () => {
  it("rejects a blank or over-long name", async () => {
    await expect(createAgent("p1", "   ", "a")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(createAgent("p1", "x".repeat(256), "a")).rejects.toMatchObject(
      { code: "BAD_REQUEST" },
    );
  });

  it.each(["Caps", "-leading", "has space", "under_score", "x".repeat(51)])(
    "rejects the identifier %j",
    async (identifier) => {
      await expect(createAgent("p1", "Name", identifier)).rejects.toMatchObject(
        { code: "BAD_REQUEST" },
      );
    },
  );

  it.each(["a", "agent-1", "9lives", "x".repeat(50)])(
    "accepts the identifier %j",
    async (identifier) => {
      await expect(createAgent("p1", "Name", identifier)).resolves.toBeTruthy();
    },
  );

  it("trims the name and identifier before use", async () => {
    await createAgent("p1", "  Padded  ", "  padded  ");
    expect(lastCreated()).toMatchObject({
      name: "Padded",
      identifier: "padded",
    });
  });

  it("409s on a duplicate identifier in the same project", async () => {
    seedParent("taken", "all");
    await expect(createAgent("p1", "Name", "taken")).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("maps a racing unique-constraint violation to the same 409", async () => {
    store.createThrows = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
    });
    await expect(createAgent("p1", "Name", "racy")).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("does not swallow an unrelated database error", async () => {
    store.createThrows = new Error("connection reset");
    await expect(createAgent("p1", "Name", "boom")).rejects.toThrow(
      "connection reset",
    );
  });

  it("issues a distinct access token per agent", async () => {
    await createAgent("p1", "One", "one");
    await createAgent("p1", "Two", "two");
    const [a, b] = store.created.map((c) => c.accessToken as string);
    expect(a).toMatch(/^aoc_[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
