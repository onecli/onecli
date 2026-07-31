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
