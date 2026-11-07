import { db, type Prisma } from "@onecli/db";
import { logger } from "../lib/logger";

const log = logger.child({ component: "runtime-ledger" });

/**
 * THE AWAKE-TIME LEDGER: one row per container run of a sandbox
 * (`SandboxRuntimeInterval`), the source of every "how long did this agent
 * run" number and, later, of the free tier's runtime allowance.
 *
 * Three rules keep it honest with no background loop and no runner clock:
 *
 * 1. OPEN with the `starting` report that names the container, inside that
 *    report's own transaction. `container_ref` is unique, so the runner's
 *    retries and a second copy's observation of the same start cannot open
 *    a second row; and a NEW container for a sandbox whose previous run is
 *    still open closes that run first (`lost`), because a sandbox runs one
 *    container at a time and the new one is proof the old one is gone.
 * 2. CLOSE on every transition that ends the run, inside that transition's
 *    transaction: the runner's `stopped`/`failed` report, a respawn, the
 *    agent's deletion. Keyed on the sandbox and guarded by `ended_at IS
 *    NULL`, so a late or repeated close is a no-op.
 * 3. SWEEP (the poll's sweep pass) for the runs nothing reported, in both
 *    directions: an open row whose sandbox is no longer up is closed at the
 *    sandbox's last status change (7% of container ends on the hosted
 *    platform logged no graceful stop, so this arm is load-bearing), and a
 *    running sandbox with no open row gets one (a `starting` report that
 *    never landed). The same pass folds every row CLOSED since the last
 *    pass into the per-day rollup.
 *
 * Reads are bounded by `ended_at`, not `started_at`: a row overlaps a window
 * when it ended after the window began (or has not ended), and both halves
 * of that are index ranges, so no row ever needs splitting however long its
 * run. Reads live in `runtime-usage-service`; this module only writes.
 */

/**
 * Why a row closed, for analytics; no decision reads it. The control plane's
 * own stops carry their claim's reason (`idle`, `evict`, `restart`), a
 * respawn and a delete name themselves, the runner's word is `stopped` or
 * `failed`, and `lost` is the sweep's (or a new container's) verdict on a
 * run nothing reported over.
 */
export type IntervalEndReason =
  | "idle"
  | "evict"
  | "restart"
  | "respawn"
  | "stopped"
  | "failed"
  | "deleted"
  | "lost";

/**
 * Open the run for `containerRef` on `sandboxId`, closing any other run
 * still open on that sandbox first (rule 1). The agent, workspace and
 * organization are resolved here, from the live rows, and copied onto the
 * row as plain ids: the usage record must outlive all three. A sandbox that
 * has no agent any more (a delete racing the start report) opens nothing.
 */
export const openRuntimeInterval = async (
  tx: Prisma.TransactionClient,
  sandboxId: string,
  containerRef: string,
): Promise<void> => {
  await tx.$executeRaw`
    UPDATE sandbox_runtime_intervals
    SET ended_at = GREATEST(started_at, now()), end_reason = 'lost'
    WHERE sandbox_id = ${sandboxId}
      AND ended_at IS NULL
      AND container_ref <> ${containerRef}
  `;
  await tx.$executeRaw`
    INSERT INTO sandbox_runtime_intervals
      (id, organization_id, workspace_id, agent_id, sandbox_id, container_ref, started_at)
    SELECT gen_random_uuid(), w.organization_id, a.workspace_id, a.id, s.id, ${containerRef}, now()
    FROM sandboxes s
    JOIN agents a ON a.id = s.agent_id
    JOIN workspaces w ON w.id = a.workspace_id
    WHERE s.id = ${sandboxId}
    ON CONFLICT (container_ref) DO NOTHING
  `;
};

/**
 * Close the sandbox's open run, if any, as of now (rule 2). Idempotent: a
 * second close finds no open row and changes nothing.
 */
export const closeRuntimeInterval = async (
  tx: Prisma.TransactionClient,
  sandboxId: string,
  reason: IntervalEndReason,
): Promise<void> => {
  await tx.$executeRaw`
    UPDATE sandbox_runtime_intervals
    SET ended_at = GREATEST(started_at, now()), end_reason = ${reason}
    WHERE sandbox_id = ${sandboxId}
      AND ended_at IS NULL
  `;
};

/**
 * How far behind the database clock the rollup's window trails. A row's
 * `ended_at` is its closing transaction's START time (`now()`), and the row
 * only becomes visible when that transaction commits; a window edge at the
 * clock would step past a row closed by a transaction still in flight and
 * never fold it. Interactive transactions here time out at 5 s and the
 * sweep's own orphan closes stamp a status change at most a poll interval
 * old, so 30 s covers both with room. The dashboard's org totals therefore
 * trail by up to half a minute for runs that just ended; the per-agent read
 * is exact because it reads the ledger itself.
 */
export const ROLLUP_LAG_SECONDS = 30;

/**
 * The rollup cursor (step 3 of the sweep): the newest `ended_at` folded so
 * far, in the database's clock. Held in this process and seeded on the first
 * pass after boot from the rollup's own newest write, less two lags (one
 * for the in-flight window the fold itself observes, one because that write
 * lands a moment after its window's edge), so a restart re-folds at most a
 * minute of closed rows. Re-folding is harmless: a day's total is recomputed
 * from the ledger, never incremented.
 */
let rollupCursor: Date | null = null;
const seedRollupCursor = async (): Promise<Date> => {
  const [row] = await db.$queryRaw<[{ floor: Date | null }]>`
    SELECT max(updated_at) AS floor FROM runtime_usage_daily
  `;
  // No rollup yet: fold everything ever closed, a one-time cost at the
  // ledger's birth (when the ledger is tiny too).
  return row.floor
    ? new Date(row.floor.getTime() - 2 * ROLLUP_LAG_SECONDS * 1000)
    : new Date(0);
};

/** Test seam: forget the in-process cursor so the next sweep re-seeds. */
export const resetRollupCursor = (): void => {
  rollupCursor = null;
};

/**
 * The poll-time reconcile (rule 3): close runs whose sandbox is down, open
 * runs whose sandbox is up unrecorded, fold newly closed rows into the daily
 * rollup. Every statement is idempotent and independent, so a failure in
 * one costs one pass, never the ledger's truth. Returns the counts for the
 * sweep's log line.
 */
export const sweepRuntimeLedger = async (): Promise<{
  orphansClosed: number;
  unrecordedOpened: number;
  daysRolledUp: number;
}> => {
  // Orphans: an open row whose sandbox is not up any more. `stopping` is
  // still up (the container runs until the runner says otherwise), so it
  // is excluded; a stop whose report is lost holds `stopping` until the
  // stale claim restarts it, and the new container closes the row then.
  // The sandbox's `updated_at` is the status change that parked it: the
  // honest end, at most a poll interval before this pass.
  const orphansClosed = await db.$executeRaw`
    UPDATE sandbox_runtime_intervals i
    SET ended_at = GREATEST(i.started_at, s.updated_at), end_reason = 'lost'
    FROM sandboxes s
    WHERE i.sandbox_id = s.id
      AND i.ended_at IS NULL
      AND s.status NOT IN ('starting', 'running', 'stopping')
  `;
  // A sandbox row that is GONE: the delete's own close ran before the
  // start report's open committed. Nothing can report this run over.
  const abandonedClosed = await db.$executeRaw`
    UPDATE sandbox_runtime_intervals i
    SET ended_at = GREATEST(i.started_at, now()), end_reason = 'deleted'
    WHERE i.ended_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM sandboxes s WHERE s.id = i.sandbox_id)
  `;
  // The other direction: a sandbox reported READY (its channel is open, so
  // the container with that ref is live) whose `starting` report never
  // landed. Opened from the ready stamp; the boot before it is lost, which
  // is the honest side to err on.
  const unrecordedOpened = await db.$executeRaw`
    INSERT INTO sandbox_runtime_intervals
      (id, organization_id, workspace_id, agent_id, sandbox_id, container_ref, started_at)
    SELECT gen_random_uuid(), w.organization_id, a.workspace_id, a.id, s.id,
           s.container_ref, s.updated_at
    FROM sandboxes s
    JOIN agents a ON a.id = s.agent_id
    JOIN workspaces w ON w.id = a.workspace_id
    WHERE s.status = 'running'
      AND s.container_ref IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM sandbox_runtime_intervals i
        WHERE i.sandbox_id = s.id AND i.ended_at IS NULL
      )
    ON CONFLICT (container_ref) DO NOTHING
  `;

  // The rollup: every row closed in (cursor, now - lag] is attributed, per
  // UTC day it touches, and each touched (org, agent, day) is RECOMPUTED
  // from every closed row overlapping that day. One statement, so the
  // window's edge and the cursor it becomes are the same database clock
  // reading. The cursor scan is an index range on (ended_at); the overlap
  // join one on (agent_id, ended_at).
  const since = rollupCursor ?? (await seedRollupCursor());
  const [rollup] = await db.$queryRaw<[{ upTo: Date; days: bigint }]>`
    WITH bounds AS (
      SELECT now() - make_interval(secs => ${ROLLUP_LAG_SECONDS}) AS up_to
    ),
    touched AS (
      SELECT DISTINCT i.organization_id, i.agent_id, d::date AS day
      FROM sandbox_runtime_intervals i
      CROSS JOIN LATERAL generate_series(
        date_trunc('day', i.started_at), date_trunc('day', i.ended_at), interval '1 day'
      ) d
      WHERE i.ended_at > ${since} AND i.ended_at <= (SELECT up_to FROM bounds)
    ),
    totals AS (
      SELECT t.organization_id, t.agent_id, t.day,
             SUM(EXTRACT(EPOCH FROM
               LEAST(i.ended_at, t.day + interval '1 day') - GREATEST(i.started_at, t.day)
             ))::bigint AS awake_seconds
      FROM touched t
      JOIN sandbox_runtime_intervals i
        ON i.agent_id = t.agent_id
       AND i.ended_at > t.day
       AND i.started_at < t.day + interval '1 day'
      GROUP BY t.organization_id, t.agent_id, t.day
    ),
    folded AS (
      INSERT INTO runtime_usage_daily (organization_id, agent_id, day, awake_seconds, updated_at)
      SELECT organization_id, agent_id, day, awake_seconds, now() FROM totals
      ON CONFLICT (organization_id, agent_id, day)
      DO UPDATE SET awake_seconds = EXCLUDED.awake_seconds, updated_at = now()
      RETURNING 1
    )
    SELECT up_to AS "upTo", (SELECT count(*) FROM folded) AS days FROM bounds
  `;
  rollupCursor = rollup.upTo;

  const result = {
    orphansClosed: orphansClosed + abandonedClosed,
    unrecordedOpened,
    daysRolledUp: Number(rollup.days),
  };
  if (result.orphansClosed > 0 || unrecordedOpened > 0) {
    log.warn(result, "runtime ledger reconciled runs nothing reported");
  }
  return result;
};
