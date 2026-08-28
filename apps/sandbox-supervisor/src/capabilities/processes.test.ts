import { describe, expect, it, vi } from "vitest";
import { cronsTools } from "./crons";
import { memoryTools } from "./memory";
import { createProcessTools, processesFragment } from "./processes";
import type { ProcessManager } from "../processes/manager";

/**
 * The model-facing background-processes contract. Unlike crons/memory, these
 * tools are LOCALLY EXECUTED — so this file (plus the manager's own zod) is
 * the enforcement authority, not a mirror of control-plane zod. The tests
 * pin the surface shape and the registry law (no cross-capability name
 * collision, every tool taught by the fragment, schemas closed).
 */

const stubManager = (): ProcessManager => ({
  start: vi.fn(() => ({ ok: true })),
  status: vi.fn(() => ({ ok: true })),
  stop: vi.fn(() => ({ ok: true })),
  watch: vi.fn(() => ({ ok: true })),
  observeUpsert: vi.fn(() => ({ created: false, hasArmedWatch: false })),
  cancelWatch: vi.fn(() => false),
  armTurnEndSafetyNet: vi.fn(() => 0),
  close: vi.fn(),
  killAllSync: vi.fn(),
});

const tools = createProcessTools(stubManager());

describe("the background-processes tool surface", () => {
  it("declares exactly the four tools, all locally executed", () => {
    expect(tools.map((tool) => tool.name)).toEqual([
      "process_start",
      "process_status",
      "process_stop",
      "process_watch",
    ]);
    for (const tool of tools) expect(typeof tool.execute).toBe("function");
  });

  it("never collides with another capability's tool names", () => {
    const taken = new Set([
      ...cronsTools.map((t) => t.name),
      ...memoryTools.map((t) => t.name),
    ]);
    for (const tool of tools) expect(taken.has(tool.name)).toBe(false);
  });

  it("every schema is closed with its required keys present", () => {
    for (const tool of tools) {
      const schema = tool.inputSchema as {
        type?: string;
        additionalProperties?: boolean;
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      for (const key of schema.required ?? []) {
        expect(schema.properties ?? {}).toHaveProperty(key);
      }
    }
  });

  it("the fragment teaches every tool name", () => {
    for (const tool of tools) {
      expect(processesFragment.body).toContain(tool.name);
    }
  });

  it("routes each tool to its manager method and rejects bad args before the manager", () => {
    const manager = stubManager();
    const live = createProcessTools(manager);
    const call = (name: string) => live.find((t) => t.name === name)!.execute!;

    // Valid start reaches the manager with the parsed args + context.
    void call("process_start")(
      { command: "echo hi" },
      { conversationId: "c", turnId: "t" },
    );
    expect(manager.start).toHaveBeenCalledWith(
      { command: "echo hi" },
      { conversationId: "c", turnId: "t" },
    );

    // A pattern watch with no pattern is refused by the schema, never reaching
    // the manager (the coherence refine — the supervisor is the authority).
    return call("process_watch")(
      { processId: "p", kind: "pattern", prompt: "go" },
      null,
    ).then((outcome) => {
      expect(outcome.ok).toBe(false);
      expect(manager.watch).not.toHaveBeenCalled();
    });
  });
});
