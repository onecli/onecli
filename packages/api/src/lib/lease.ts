/**
 * A row lease held by a live process: written with an expiry, renewed while
 * its holder works, so it lapses only when the holder dies. Whoever finds a
 * lapsed lease may take the row over; the holder's own token fences its
 * writes, so a holder that overran its lease never touches the row of the
 * one that took it over.
 */

/** How long a lease holds without renewal: far past one missed renewal. */
export const LEASE_MS = 2 * 60 * 1000;

/** Renewal cadence while the holder works: well inside the lease. */
const LEASE_RENEW_MS = 30 * 1000;

/** The expiry of a lease taken or renewed at `from`. */
export const leaseExpiry = (from: number = Date.now()): Date =>
  new Date(from + LEASE_MS);

/**
 * Run `work` while its lease is renewed every `LEASE_RENEW_MS` by `renew`.
 * A failed renewal is reported to `onRenewError` and the work goes on: the
 * next renewal may land, and a lease that does lapse is exactly the case the
 * takeover exists for.
 */
export const whileLeased = async <T>(
  lease: {
    renew: () => Promise<unknown>;
    onRenewError: (err: unknown) => void;
  },
  work: () => Promise<T>,
): Promise<T> => {
  const timer = setInterval(() => {
    void lease.renew().catch(lease.onRenewError);
  }, LEASE_RENEW_MS);
  timer.unref();
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
};
