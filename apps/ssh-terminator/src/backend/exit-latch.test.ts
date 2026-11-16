import { describe, expect, it } from "vitest";
import { createExitLatch } from "./exit-latch";

describe("createExitLatch", () => {
  it("is unsettled until the first resolve, which wins", async () => {
    const exit = createExitLatch();
    expect(exit.isSettled()).toBe(false);
    exit.resolve(3);
    expect(exit.isSettled()).toBe(true);
    exit.resolve(4);
    exit.reject(new Error("late"));
    await expect(exit.exited).resolves.toBe(3);
  });

  it("settles on the first reject, which wins", async () => {
    const exit = createExitLatch();
    const first = new Error("first");
    exit.reject(first);
    expect(exit.isSettled()).toBe(true);
    exit.reject(new Error("second"));
    exit.resolve(0);
    await expect(exit.exited).rejects.toBe(first);
  });
});
