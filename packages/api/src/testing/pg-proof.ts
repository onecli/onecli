/**
 * The one gate for the `*.pg.test.ts` proof suites.
 *
 * These suites drive real writes against a real PostgreSQL and read them back
 * the way their consumer does — the only level at which "which rows land where"
 * bugs are visible. Locally they skip when no database is configured, which is
 * the right default: not every contributor wants a container running.
 *
 * In CI that same skip is a trap. A suite that silently disappears reports the
 * same green as one that passed, so a renamed or dropped environment variable
 * removes the coverage and nothing says so. That is not hypothetical — the
 * gateway's own integration tests early-returned on a variable CI never set,
 * and 8 tests × 5 lanes went unnoticed for months before they were deleted.
 *
 * So: skip locally, fail loudly in CI. Written once and imported, rather than
 * copied into each suite — the copies are exactly how the previous instance of
 * this bug stayed invisible.
 */
export const proofDatabaseUrl = (): string | undefined => {
  const url = process.env.POLICY_PROOF_DATABASE_URL;
  if (url !== undefined && url !== "") return url;

  if (process.env.CI !== undefined && process.env.CI !== "") {
    throw new Error(
      "POLICY_PROOF_DATABASE_URL must be set in CI: the pg proof suites must " +
        "not silently skip. Start a PostgreSQL, run `prisma migrate deploy` " +
        "against it, and pass its URL to the test step.",
    );
  }

  return undefined;
};

/** The one query surface `waitForLockWaiters` needs (a PrismaClient fits). */
export interface LockWaitQuerier {
  $queryRawUnsafe: <T = unknown>(
    query: string,
    ...values: unknown[]
  ) => Promise<T>;
}

/**
 * Resolves once at least `count` backends of this database are parked on a
 * lock (optionally only those whose current query matches `queryLike`, an
 * ILIKE pattern). Race proofs use it instead of a sleep: "the loser is
 * blocked" becomes a checked precondition, not a timing guess that turns
 * vacuous on a slow runner. Run it on a connection outside the transaction
 * holding the lock. The pg project runs files serially, so no other suite's
 * backend competes.
 */
export const waitForLockWaiters = async (
  db: LockWaitQuerier,
  options: { count?: number; queryLike?: string; timeoutMs?: number } = {},
): Promise<void> => {
  const { count = 1, queryLike = "%", timeoutMs = 5_000 } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await db.$queryRawUnsafe<Array<{ n: bigint | number }>>(
      `SELECT count(*)::bigint AS n FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND query ILIKE $1`,
      queryLike,
    );
    if (Number(rows[0]?.n ?? 0) >= count) return;
    if (Date.now() > deadline) {
      throw new Error(`no ${count} backend(s) reached a lock wait in time`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
