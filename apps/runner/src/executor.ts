/**
 * Concurrency primitives for the runner's lifecycle executor: per-key FIFO
 * chains plus a counted semaphore.
 *
 * The shape they compose into: every work item runs on its sandbox's chain
 * (all per-sandbox ordering guarantees — sync-before-turn, deliver-before-
 * steer, start-before-deliver — are FIFO properties of one chain), while only
 * STARTS additionally take the global semaphore. At size 1 starts stay
 * globally serialized exactly as the old serial tick kept them; stops and
 * reconcile are deliberately exempt (stops must never queue past the control
 * plane's stale-claim window, and reconcile always ran off the tick). Raising
 * the size lets a slow wake stop head-of-line-blocking every other sandbox's
 * lifecycle.
 */

export interface KeyedChains {
  /** Append a task to `key`'s FIFO chain (creating it when absent). */
  enqueue(key: string, task: () => Promise<void>): void;
  /** Resolves once every chain that exists right now (and any task those
   * tasks enqueue) has settled — the test/shutdown drain. */
  settled(): Promise<void>;
}

export const createKeyedChains = (
  onError: (key: string, error: unknown) => void,
): KeyedChains => {
  const chains = new Map<string, Promise<void>>();

  return {
    enqueue(key, task) {
      const previous = chains.get(key) ?? Promise.resolve();
      // Errors are swallowed into the callback so one failed task can never
      // poison the chain for every later item on the same sandbox.
      const next = previous.then(task).catch((error: unknown) => {
        onError(key, error);
      });
      chains.set(key, next);
      void next.finally(() => {
        if (chains.get(key) === next) chains.delete(key);
      });
    },

    async settled() {
      while (chains.size > 0) {
        await Promise.all([...chains.values()]);
      }
    },
  };
};

export interface Semaphore {
  /** Resolves with the release function once a slot is free. Releasing twice
   * is a no-op — a `finally` around a task that also releases early is safe. */
  acquire(): Promise<() => void>;
}

export const createSemaphore = (size: number): Semaphore => {
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
  };
};
