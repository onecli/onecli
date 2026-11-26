/**
 * The exit promise both exec backends hand the relay. It settles once: the
 * first `resolve` or `reject` wins and every later call is a no-op, because a
 * transport error, a close and the exit status can each arrive in any order.
 */
interface ExitLatch {
  exited: Promise<number>;
  resolve(code: number): void;
  reject(error: Error): void;
  isSettled(): boolean;
}

export const createExitLatch = (): ExitLatch => {
  let settled = false;
  let resolveExit: (code: number) => void = () => undefined;
  let rejectExit: (error: Error) => void = () => undefined;
  const exited = new Promise<number>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  return {
    exited,
    resolve: (code) => {
      if (settled) return;
      settled = true;
      resolveExit(code);
    },
    reject: (error) => {
      if (settled) return;
      settled = true;
      rejectExit(error);
    },
    isSettled: () => settled,
  };
};
