import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory `@onecli/db` mock covering only what `createAgent` touches. The
// load-bearing case since attach-model step 5: EVERY new agent is created
// `selective` with nothing attached — no default-to-all, and no parent-mode
// inheritance (an unconverted "all" parent minting new all-mode children would
// keep step 7's zero-"all" gate from ever converging).

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

describe("createAgent — always selective (attach-model step 5)", () => {
  it("creates selective with no parent", async () => {
    await createAgent("p1", "Solo", "solo");
    expect(lastCreated().secretMode).toBe("selective");
  });

  it("creates selective even when a selective parent exists — fail-closed with no grants", async () => {
    seedParent("parent", "selective");
    await createAgent("p1", "Child", "child");
    expect(lastCreated().secretMode).toBe("selective");
  });

  it("does NOT inherit an all-mode parent's mode during the grace window", async () => {
    // The step-5 law: inheritance is gone (the parameter itself was removed —
    // the route still accepts `parentIdentifier` but no longer threads it).
    // An unconverted "all" parent must never mint new all-mode agents — the
    // gateway no longer reads the column (step 7), but the converter's
    // workload and step 8's drop census both depend on no new "all" rows.
    seedParent("parent", "all");
    await createAgent("p1", "Child", "child");
    expect(lastCreated().secretMode).toBe("selective");
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
