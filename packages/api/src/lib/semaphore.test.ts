import { describe, expect, it } from "vitest";
import { createSemaphore, withSlot } from "./semaphore";

describe("semaphore", () => {
  it("admits `size` at once, parks the rest FIFO, and a double release is a no-op", async () => {
    const sem = createSemaphore(2);
    const order: string[] = [];
    const gate = (label: string) =>
      withSlot(sem, async () => {
        order.push(`start ${label}`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`end ${label}`);
      });
    const all = Promise.all([gate("a"), gate("b"), gate("c")]);
    await Promise.resolve();
    expect(sem.inUse()).toBe(2);
    expect(sem.waiting()).toBe(1);
    await all;
    expect(order.indexOf("start c")).toBeGreaterThan(
      Math.min(order.indexOf("end a"), order.indexOf("end b")),
    );
    expect(sem.inUse()).toBe(0);

    const release = await sem.acquire();
    release();
    release();
    expect(sem.inUse()).toBe(0);
  });

  it("releases the slot when the task throws", async () => {
    const sem = createSemaphore(1);
    await expect(
      withSlot(sem, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(sem.inUse()).toBe(0);
  });

  it("refuses a non-positive size", () => {
    expect(() => createSemaphore(0)).toThrow(/positive integer/);
  });
});
