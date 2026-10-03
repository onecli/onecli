/**
 * A counting semaphore — the runner's `executor.ts` shape, here for the api's
 * own bounded-concurrency needs (the outbound-attachment blob writes). Kept
 * tiny and dependency-free on purpose; a queue library would be a dependency
 * for twenty lines.
 */
export interface Semaphore {
  /** Resolves with the release function once a slot is free. Releasing twice
   * is a no-op — a `finally` around a task that also releases early is safe. */
  acquire(): Promise<() => void>;
  /** Slots in use right now (tests and gauges). */
  inUse(): number;
  /** Callers parked waiting for a slot (tests and gauges). */
  waiting(): number;
}

export const createSemaphore = (size: number): Semaphore => {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`semaphore size must be a positive integer, got ${size}`);
  }
  let inUse = 0;
  const waiters: Array<() => void> = [];

  const grant = (): (() => void) => {
    inUse += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inUse -= 1;
      waiters.shift()?.();
    };
  };

  return {
    acquire() {
      if (inUse < size) return Promise.resolve(grant());
      return new Promise((resolve) => {
        waiters.push(() => resolve(grant()));
      });
    },
    inUse: () => inUse,
    waiting: () => waiters.length,
  };
};

/** Run `fn` inside one slot of `semaphore`. */
export const withSlot = async <T>(
  semaphore: Semaphore,
  fn: () => Promise<T>,
): Promise<T> => {
  const release = await semaphore.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
};
