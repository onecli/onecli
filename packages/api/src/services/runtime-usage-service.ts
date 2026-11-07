import { db, Prisma } from "@onecli/db";
import { ServiceError } from "./errors";
import type {
  AgentAwakeTime,
  AgentRuntimeUsage,
  OrgRuntimeUsage,
  UsageWindow,
} from "../validations/usage";

/**
 * RUNTIME USAGE READS: how long an agent (or each of an org's agents) was
 * AWAKE in a window of whole UTC days. Every number is the overlap of each
 * run with [from, to): a run still open counts up to now.
 *
 * Two sources, split at today's midnight, the line the ledger sweep
 * maintains:
 *
 * - PAST DAYS come from the daily rollup (`runtime_usage_daily`: one row per
 *   (org, agent, day) of CLOSED runs, recomputed per day by the sweep). A
 *   year is at most 366 rows per agent, whatever the ledger holds. A run
 *   that is still OPEN has no rollup rows yet, so its past days are read
 *   from its own ledger row: the open rows are a tiny indexed set
 *   (`ended_at IS NULL`), one per running sandbox.
 * - TODAY comes from the ledger: the runs that ended today (a range on
 *   `ended_at`) and the open ones. Today is the only day the rollup cannot
 *   know yet.
 *
 * A closed run therefore reaches a past day's total one sweep late (under
 * a minute) and today's total at once; the `running` flag is live.
 *
 * Fencing is in the SQL: the agent read is behind the same workspace-and-org
 * fence every per-agent read uses, and both reads filter by the rollup's
 * and the ledger's own `organization_id`, so an id from another tenant
 * yields nothing.
 */

const todayStart = (): Date => {
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  return day;
};

/** The overlap of one ledger row with [from, to), in seconds (never
 * negative: a row outside the segment contributes 0). */
const overlapSeconds = (from: Date, to: Date) => Prisma.sql`
  GREATEST(EXTRACT(EPOCH FROM
    LEAST(COALESCE(i.ended_at, now()), ${to}) - GREATEST(i.started_at, ${from})
  ), 0)
`;

/**
 * Where the rollup stops and the ledger starts, clamped into the window:
 * today's midnight, or `to` when the window ends earlier, or `from` when it
 * starts later. The rollup answers [from, split), the ledger [split, to)
 * for every row and [from, split) for open rows.
 */
const splitAt = (window: UsageWindow): Date => {
  const today = todayStart();
  if (today < window.from) return window.from;
  if (today > window.to) return window.to;
  return today;
};

/**
 * The ledger's share of the window, per row: the overlap past the split for
 * every row, plus the overlap before it for OPEN rows only (the rollup has
 * the closed rows' past days).
 */
const ledgerShare = (window: UsageWindow) => {
  const split = splitAt(window);
  return Prisma.sql`(
    ${overlapSeconds(split, window.to)}
    + CASE WHEN i.ended_at IS NULL
        THEN ${overlapSeconds(window.from, split)} ELSE 0 END
  )`;
};

/** The ledger rows that can contribute: open, or ended after the split. */
const ledgerRows = (window: UsageWindow) => Prisma.sql`
  (i.ended_at IS NULL OR i.ended_at > ${splitAt(window)}) AND i.started_at < ${window.to}
`;

/** The rollup's days inside the window: [from, split). */
const rollupDays = (window: UsageWindow) =>
  Prisma.sql`r.day >= ${window.from}::date AND r.day < ${splitAt(window)}::date`;

export const getAgentRuntimeUsage = async (
  workspaceId: string,
  organizationId: string,
  agentId: string,
  window: UsageWindow,
): Promise<AgentRuntimeUsage> => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId, workspace: { organizationId } },
    select: { id: true },
  });
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");

  const [row] = await db.$queryRaw<
    [{ rolled: number; live: number; running: boolean }]
  >`
    SELECT
      (
        SELECT COALESCE(SUM(r.awake_seconds), 0) FROM runtime_usage_daily r
        WHERE r.organization_id = ${organizationId} AND r.agent_id = ${agentId}
          AND ${rollupDays(window)}
      )::float8 AS rolled,
      (
        SELECT COALESCE(SUM(${ledgerShare(window)}), 0) FROM sandbox_runtime_intervals i
        WHERE i.organization_id = ${organizationId} AND i.agent_id = ${agentId}
          AND ${ledgerRows(window)}
      )::float8 AS live,
      EXISTS (
        SELECT 1 FROM sandbox_runtime_intervals i
        WHERE i.organization_id = ${organizationId} AND i.agent_id = ${agentId}
          AND i.ended_at IS NULL
      ) AS running
  `;
  return {
    agentId,
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    awakeSeconds: Math.floor(row.rolled + row.live),
    running: row.running,
  };
};

export const getOrgRuntimeUsage = async (
  organizationId: string,
  window: UsageWindow,
): Promise<OrgRuntimeUsage> => {
  const rows = await db.$queryRaw<{ agentId: string; seconds: number }[]>`
    WITH shares AS (
      SELECT r.agent_id, r.awake_seconds::float8 AS seconds
      FROM runtime_usage_daily r
      WHERE r.organization_id = ${organizationId} AND ${rollupDays(window)}
      UNION ALL
      SELECT i.agent_id, ${ledgerShare(window)}
      FROM sandbox_runtime_intervals i
      WHERE i.organization_id = ${organizationId} AND ${ledgerRows(window)}
    )
    SELECT agent_id AS "agentId", SUM(seconds)::float8 AS seconds
    FROM shares
    GROUP BY agent_id
    HAVING SUM(seconds) > 0
    ORDER BY 2 DESC
  `;
  const agents: AgentAwakeTime[] = rows.map((row) => ({
    agentId: row.agentId,
    awakeSeconds: Math.floor(row.seconds),
  }));
  return {
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    agents,
    awakeSeconds: agents.reduce((sum, agent) => sum + agent.awakeSeconds, 0),
  };
};
