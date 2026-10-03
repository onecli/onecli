/**
 * A token bucket that counts what it refuses.
 *
 * Log forwarding must stay bounded no matter what the source does: a
 * runaway harness (or an agent deliberately flooding its own log) must not
 * turn into unbounded stderr (a deployment that ships every line pays for
 * every line). Refusals are counted, never silent: the caller reports the count
 * on the next line it lets through (`takeSuppressed`), so a gap in the log
 * always says how big it was.
 */
export interface RateLimiter {
  /** True when one more line may pass now; false (and counted) otherwise. */
  tryTake(): boolean;
  /** Lines refused since the last call: reported once, then reset. */
  takeSuppressed(): number;
}

export interface RateLimiterOptions {
  /** Sustained lines per second. */
  ratePerSecond: number;
  /** Bucket size: the burst a quiet source may spend at once. */
  burst: number;
  /** Clock seam for tests. */
  now?: () => number;
}

export const createRateLimiter = ({
  ratePerSecond,
  burst,
  now = () => Date.now(),
}: RateLimiterOptions): RateLimiter => {
  let tokens = burst;
  let last = now();
  let suppressed = 0;

  return {
    tryTake() {
      const at = now();
      tokens = Math.min(burst, tokens + ((at - last) / 1000) * ratePerSecond);
      last = at;
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      suppressed += 1;
      return false;
    },
    takeSuppressed() {
      const count = suppressed;
      suppressed = 0;
      return count;
    },
  };
};
