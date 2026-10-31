import { afterEach, describe, expect, it, vi } from "vitest";
import { LEASE_MS, leaseExpiry, whileLeased } from "./lease";

afterEach(() => {
  vi.useRealTimers();
});

describe("whileLeased", () => {
  it("renews the lease while the work runs, and stops once it settles", async () => {
    vi.useFakeTimers();
    const renew = vi.fn().mockResolvedValue(undefined);
    let finish!: (value: string) => void;
    const running = whileLeased(
      { renew, onRenewError: vi.fn() },
      () => new Promise<string>((resolve) => (finish = resolve)),
    );

    await vi.advanceTimersByTimeAsync(LEASE_MS);
    // Renewed well inside the lease, more than once.
    expect(renew.mock.calls.length).toBeGreaterThanOrEqual(3);

    finish("done");
    await expect(running).resolves.toBe("done");
    const renewals = renew.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LEASE_MS);
    expect(renew).toHaveBeenCalledTimes(renewals);
  });

  it("stops renewing when the work throws, and rethrows", async () => {
    vi.useFakeTimers();
    const renew = vi.fn().mockResolvedValue(undefined);
    await expect(
      whileLeased({ renew, onRenewError: vi.fn() }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await vi.advanceTimersByTimeAsync(LEASE_MS);
    expect(renew).not.toHaveBeenCalled();
  });

  it("reports a failed renewal and keeps working", async () => {
    vi.useFakeTimers();
    const failure = new Error("db blip");
    const onRenewError = vi.fn();
    let finish!: () => void;
    const running = whileLeased(
      { renew: () => Promise.reject(failure), onRenewError },
      () => new Promise<void>((resolve) => (finish = resolve)),
    );

    await vi.advanceTimersByTimeAsync(LEASE_MS);
    expect(onRenewError).toHaveBeenCalledWith(failure);
    finish();
    await expect(running).resolves.toBeUndefined();
  });
});

describe("leaseExpiry", () => {
  it("is one lease past the given moment", () => {
    expect(leaseExpiry(1_000).getTime()).toBe(1_000 + LEASE_MS);
  });
});
