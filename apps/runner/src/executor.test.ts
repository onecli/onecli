import { describe, expect, it } from "vitest";
import { createKeyedChains, createSemaphore } from "./executor";

describe("createSemaphore", () => {
  it("bounds concurrency and grants waiters in FIFO order", async () => {
    const semaphore = createSemaphore(2);
    const order: number[] = [];
    const releases: Array<() => void> = [];

    releases.push(await semaphore.acquire());
    releases.push(await semaphore.acquire());
    const third = semaphore.acquire().then((release) => {
      order.push(3);
      releases.push(release);
    });
    const fourth = semaphore.acquire().then((release) => {
      order.push(4);
      releases.push(release);
    });

    // Both slots held: neither waiter may have run yet.
    await Promise.resolve();
    expect(order).toEqual([]);

    releases[0]?.();
    await third;
    expect(order).toEqual([3]);
    releases[1]?.();
    await fourth;
    expect(order).toEqual([3, 4]);
  });

  it("tolerates double release — a slot is never freed twice", async () => {
    const semaphore = createSemaphore(1);
    const release = await semaphore.acquire();
    release();
    release();
    // If the double release freed two slots, both of these would resolve
    // without the first being released.
    const a = await semaphore.acquire();
    let secondGranted = false;
    void semaphore.acquire().then(() => {
      secondGranted = true;
    });
    await Promise.resolve();
    expect(secondGranted).toBe(false);
    a();
  });
});

describe("createKeyedChains", () => {
  it("serializes per key, runs keys concurrently, and isolates errors", async () => {
    const errors: string[] = [];
    const chains = createKeyedChains((key) => errors.push(key));
    const ran: string[] = [];
    let releaseA: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    chains.enqueue("a", async () => {
      await gate;
      ran.push("a1");
    });
    chains.enqueue("a", async () => {
      ran.push("a2");
    });
    chains.enqueue("b", async () => {
      throw new Error("boom");
    });
    chains.enqueue("b", async () => {
      ran.push("b2");
    });

    // b's chain proceeds past its failed task while a's first is still held.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ran).toEqual(["b2"]);
    expect(errors).toEqual(["b"]);

    releaseA();
    await chains.settled();
    expect(ran).toEqual(["b2", "a1", "a2"]);
  });
});
