import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TURN_CONTEXT_CHARS } from "@onecli/agent-protocol";

/**
 * The turn-start context composer (step 8, revised): the memory index's
 * shape, the snippet gate, the human-only continuity bridge, and — the one
 * that must never drift — the budget: maximal inputs stay inside
 * MAX_TURN_CONTEXT_CHARS. The bridge itself rides this context channel now
 * (never turn.message), so it is composed HERE, not prepended at createTurn.
 */

const state = vi.hoisted(() => ({
  memories: [] as {
    key: string;
    title: string | null;
    description: string | null;
    content: string;
  }[],
  turn: { createdAt: new Date("2026-08-09T00:00:00Z"), source: "web" } as {
    createdAt: Date;
    source: string;
  } | null,
}));

const search = vi.hoisted(() => ({ searchMemories: vi.fn() }));
const bridge = vi.hoisted(() => ({
  buildContinuityBridge: vi.fn(),
  buildOpenPromiseNote: vi.fn(),
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    // The index read is a raw select of `left(content, 400)` (the 100k cap
    // made full-body reads a 10MB-per-turn cost) — mirror its shape: the
    // fixtures keep authoring plain `content`, the mock derives the head
    // exactly as the SQL does.
    $queryRaw: async () =>
      state.memories.map(({ content, ...rest }) => ({
        ...rest,
        contentHead: content.slice(0, 400),
      })),
    turn: { findUnique: async () => state.turn },
  },
}));

vi.mock("./agent-memory-service", () => ({
  searchMemories: search.searchMemories,
  // Real co-importers of the mocked module still need these to exist.
  MAX_MEMORIES_PER_AGENT: 100,
  MEMORY_SEARCH_LIMIT: 8,
}));

vi.mock("./turn-service", () => ({
  buildContinuityBridge: bridge.buildContinuityBridge,
  buildOpenPromiseNote: bridge.buildOpenPromiseNote,
}));

const { buildTurnContext, MEMORY_INJECT_MAX, MEMORY_INJECT_RANK_FLOOR } =
  await import("./turn-context-service");

const memory = (
  key: string,
  overrides: Partial<(typeof state.memories)[number]> = {},
) => ({ key, title: null, description: null, content: "body", ...overrides });

/** The revised signature — a human turn with no bridge unless a test sets one. */
const build = (agentId: string, message: string) =>
  buildTurnContext(agentId, "c-1", "t-1", message);

beforeEach(() => {
  state.memories = [];
  state.turn = { createdAt: new Date("2026-08-09T00:00:00Z"), source: "web" };
  search.searchMemories.mockReset();
  search.searchMemories.mockResolvedValue([]);
  bridge.buildContinuityBridge.mockReset();
  bridge.buildContinuityBridge.mockResolvedValue(null);
  bridge.buildOpenPromiseNote.mockReset();
  bridge.buildOpenPromiseNote.mockResolvedValue(null);
});

describe("the index", () => {
  it("an agent with nothing saved and no bridge gets NO context at all", async () => {
    expect(await build("ag-1", "hello")).toBeNull();
  });

  it("renders one line per memory with the description", async () => {
    state.memories = [
      memory("deploy-notes", { description: "How we deploy the api" }),
    ];
    const context = await build("ag-1", "hello");
    expect(context).toContain("- deploy-notes: How we deploy the api");
    expect(context?.startsWith("[Your memory — ")).toBe(true);
    expect(context?.endsWith("[End of memory]")).toBe(true);
  });

  it("falls back description → title → first content line", async () => {
    state.memories = [
      memory("a-titled", { title: "The title" }),
      memory("b-bare", { content: "\n\n  First real line\nsecond" }),
    ];
    const context = await build("ag-1", "hello");
    expect(context).toContain("- a-titled: The title");
    expect(context).toContain("- b-bare: First real line");
  });

  it("strips control characters and newlines out of index lines", async () => {
    state.memories = [
      memory("sneaky", {
        description: `line one${String.fromCharCode(0x07)} ${String.fromCharCode(0x2028)}with separators`,
      }),
    ];
    const context = await build("ag-1", "hello");
    expect(context).toContain("- sneaky: line one with separators");
  });

  it("closes an overflowing index with the honest count", async () => {
    state.memories = Array.from({ length: 100 }, (_, i) =>
      memory(`key-${String(i).padStart(3, "0")}`, {
        description: "d".repeat(159),
      }),
    );
    const context = await build("ag-1", "hello");
    expect(context).toMatch(/- …and \d+ more — memory_list shows all\./);
  });
});

describe("the snippet gate", () => {
  it("layers confident hits, drops the rest at the floor", async () => {
    state.memories = [memory("deploy-notes")];
    search.searchMemories.mockResolvedValue([
      {
        key: "deploy-notes",
        title: null,
        description: null,
        snippet: "Deploys run from **CI**.",
        rank: 0.6,
        updatedAt: new Date(),
      },
      {
        key: "weak-hit",
        title: null,
        description: null,
        snippet: "barely",
        rank: MEMORY_INJECT_RANK_FLOOR - 0.01,
        updatedAt: new Date(),
      },
    ]);
    const context = await build("ag-1", "how do deploys work?");
    expect(context).toContain("[Possibly relevant to this message:]");
    expect(context).toContain("### deploy-notes");
    expect(context).not.toContain("weak-hit");
    expect(search.searchMemories).toHaveBeenCalledWith(
      "ag-1",
      "how do deploys work?",
      MEMORY_INJECT_MAX,
    );
  });

  it("retrieval reads the message verbatim — the bridge never rides it now", async () => {
    state.memories = [memory("k")];
    await build("ag-1", "what was that number?");
    expect(search.searchMemories).toHaveBeenCalledWith(
      "ag-1",
      "what was that number?",
      MEMORY_INJECT_MAX,
    );
  });

  it("no snippet block at all when nothing clears the floor", async () => {
    state.memories = [memory("k")];
    const context = await build("ag-1", "hello");
    expect(context).not.toContain("[Possibly relevant");
  });
});

describe("the continuity bridge (human-only, rides context)", () => {
  it("delivers the bridge even with ZERO memories (empty index must not suppress it)", async () => {
    // MUTATION-PROOF: keep the memory-empty early-return and this is null.
    state.memories = [];
    bridge.buildContinuityBridge.mockResolvedValue(
      '[Context from your automated runs …]\nWatch on "x"\nreport\n[End of automated-run context]',
    );
    const context = await build("ag-1", "what was that?");
    expect(context).toContain("[Context from your automated runs");
  });

  it("sits NEAREST the message: memory first, bridge last", async () => {
    state.memories = [memory("k")];
    bridge.buildContinuityBridge.mockResolvedValue("BRIDGE-BLOCK");
    const context = (await build("ag-1", "hi")) ?? "";
    expect(context.indexOf("[Your memory")).toBeLessThan(
      context.indexOf("BRIDGE-BLOCK"),
    );
  });

  it("a cron/watch RUN turn gets memory but NO bridge (never built)", async () => {
    state.turn = {
      createdAt: new Date("2026-08-09T00:00:00Z"),
      source: "watch",
    };
    state.memories = [memory("k")];
    await build("ag-1", "run report");
    expect(bridge.buildContinuityBridge).not.toHaveBeenCalled();
  });

  it("a WAKE gets the agent's own last reply — the promise it may still owe", async () => {
    // The mirror image of the bridge. A wake arrives with the platform's
    // instruction and no conversation, so an agent that said "I'll post the
    // rankings once all five finish" answers only the question it was asked
    // and never delivers. Observed live 2026-09-01.
    //
    // MUTATION-PROOF: drop the promise arm and this fails.
    state.turn = {
      createdAt: new Date("2026-08-09T00:00:00Z"),
      source: "watch",
    };
    bridge.buildOpenPromiseNote.mockResolvedValue("[Your last reply…]");

    const out = await build("ag-1", "run report");

    expect(bridge.buildOpenPromiseNote).toHaveBeenCalledWith(
      "c-1",
      new Date("2026-08-09T00:00:00Z"),
    );
    expect(out).toContain("[Your last reply…]");
  });

  it("a HUMAN turn gets the bridge, never the promise note", async () => {
    // Exactly one applies. A person is present to say what they want; the
    // note exists for the turn where nobody is.
    state.turn = {
      createdAt: new Date("2026-08-09T00:00:00Z"),
      source: "slack",
    };

    await build("ag-1", "hello");

    expect(bridge.buildContinuityBridge).toHaveBeenCalled();
    expect(bridge.buildOpenPromiseNote).not.toHaveBeenCalled();
  });
});

describe("the budget", () => {
  it("maximal inputs never exceed MAX_TURN_CONTEXT_CHARS", async () => {
    // Worst case everywhere: full memory cap + max snippets + a maximal bridge.
    state.memories = Array.from({ length: 100 }, (_, i) =>
      memory(`k${"x".repeat(76)}-${i}`, { description: "d".repeat(300) }),
    );
    search.searchMemories.mockResolvedValue(
      Array.from({ length: 3 }, (_, i) => ({
        key: `k-${i}`,
        title: null,
        description: null,
        snippet: "s".repeat(5_000),
        rank: 0.9,
        updatedAt: new Date(),
      })),
    );
    bridge.buildContinuityBridge.mockResolvedValue("b".repeat(50_000));
    // The promise note rides the same budget. It cannot appear beside the
    // bridge today (exactly one applies), but the cap must hold if that
    // ever changes — a context past the ceiling is silently truncated, and
    // the tail is where the newest information sits.
    bridge.buildOpenPromiseNote.mockResolvedValue("p".repeat(50_000));
    const context = await build("ag-1", "m".repeat(50_000));
    expect(context).not.toBeNull();
    expect((context as string).length).toBeLessThanOrEqual(
      MAX_TURN_CONTEXT_CHARS,
    );
  });
});
