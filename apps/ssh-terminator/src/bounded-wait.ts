/**
 * Resolves when `settle` reports done, or when `timeoutMs` elapses, whichever
 * comes first. Never rejects (a `settle` that throws counts as done), so a
 * wedged or stalled peer cannot pin a closing channel's socket open. The
 * timer is unref'd and does not hold the process open.
 */
export const boundedWait = (
  settle: (done: () => void) => void,
  timeoutMs: number,
): Promise<void> =>
  new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    try {
      settle(finish);
    } catch {
      finish();
    }
  });
