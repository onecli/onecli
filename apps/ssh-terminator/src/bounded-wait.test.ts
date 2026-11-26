import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedWait } from "./bounded-wait";

const state = (promise: Promise<void>) => {
  let value: "pending" | "resolved" | "rejected" = "pending";
  promise.then(
    () => (value = "resolved"),
    () => (value = "rejected"),
  );
  return () => value;
};

describe("boundedWait", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves as soon as settle reports done, before the bound", async () => {
    vi.useFakeTimers();
    let done: () => void = () => undefined;
    const waited = state(
      boundedWait((d) => {
        done = d;
      }, 1_000),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(waited()).toBe("pending");
    done();
    await vi.advanceTimersByTimeAsync(0);
    expect(waited()).toBe("resolved");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves on the bound when settle never reports done", async () => {
    vi.useFakeTimers();
    const waited = state(boundedWait(() => undefined, 1_000));
    await vi.advanceTimersByTimeAsync(999);
    expect(waited()).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(waited()).toBe("resolved");
  });

  it("resolves (never rejects) when settle throws", async () => {
    vi.useFakeTimers();
    const waited = state(
      boundedWait(() => {
        throw new Error("torn channel");
      }, 1_000),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(waited()).toBe("resolved");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tolerates done being called synchronously and more than once", async () => {
    vi.useFakeTimers();
    const waited = state(
      boundedWait((done) => {
        done();
        done();
      }, 1_000),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(waited()).toBe("resolved");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not keep the process alive while waiting", () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    void boundedWait(() => undefined, 60_000);
    const timer = spy.mock.results.at(-1)?.value as NodeJS.Timeout;
    spy.mockRestore();
    expect(timer.hasRef()).toBe(false);
    clearTimeout(timer);
  });
});
