import { describe, expect, it, vi } from "vitest";
import type { HarnessBackgroundTask } from "@onecli/agent-protocol";
import { mergeBackgroundTasks } from "./background-merge";

vi.mock("../log", () => ({ log: vi.fn() }));

const task = (ref: string): HarnessBackgroundTask => ({
  ref,
  command: `cmd ${ref}`,
  status: "running",
  startedAt: "2026-08-25T00:00:00.000Z",
  wantsWake: false,
});

describe("mergeBackgroundTasks", () => {
  it("concatenates every source's tasks", async () => {
    const merged = mergeBackgroundTasks(
      { poll: async () => [task("a"), task("b")] },
      { poll: async () => [task("c")] },
    );
    const tasks = await merged.poll();
    expect(tasks.map((t) => t.ref)).toEqual(["a", "b", "c"]);
  });

  it("a failing source never starves the others", async () => {
    const merged = mergeBackgroundTasks(
      {
        poll: async () => {
          throw new Error("wedged");
        },
      },
      { poll: async () => [task("survivor")] },
    );
    const tasks = await merged.poll();
    expect(tasks.map((t) => t.ref)).toEqual(["survivor"]);
    // And the merged poll itself keeps the never-throw contract.
    await expect(merged.poll()).resolves.toBeDefined();
  });

  it("no sources means no tasks", async () => {
    expect(await mergeBackgroundTasks().poll()).toEqual([]);
  });
});
