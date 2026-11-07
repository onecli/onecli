import { db, Prisma } from "@onecli/db";
import type {
  RunnerChannelClaimRequest,
  RunnerChannelClaimResponse,
  RunnerChannelState,
  RunnerSandboxChannel,
} from "@onecli/agent-protocol";
import { signalWork } from "./due-work";
import {
  isLiveReplica,
  lifecycleFreeFor,
  liveReplicaSql,
} from "./runner-replica-fence";

/**
 * WHERE EACH SANDBOX'S CONTROL CHANNEL IS (the runner multi-copy plane).
 *
 * A runner may run as several copies behind one address. A supervisor dials
 * that address and lands on any copy, so no copy can rely on its own memory
 * for which sandboxes it hosts. Postgres is the one record:
 *
 * - the spawn: the container the start created and the SHA-256 of the
 *   bootstrap token baked into it (the token itself never leaves the
 *   runner), recorded before the sandbox boots, so any copy can accept the
 *   first connect;
 * - the holder: the copy and connection holding the socket now, which is
 *   what routes the sandbox's socket-bound work to that copy;
 * - `channel_since`: when the current state began (spawn recorded, socket
 *   claimed, socket dropped).
 *
 * Every write here is raw SQL so it never moves `updated_at`, which is the
 * start/stop arms' stale-claim clock. Every write is fenced by the runner
 * that owns the sandbox, and every refusal is hint-free (the caller learns
 * "not applied", never why).
 */

/**
 * Record the spawn a start just created. Applied only while the sandbox is
 * still `starting` under this runner AND the calling copy still owns its
 * lifecycle (the fencing token: a copy whose start was overtaken, because it
 * paused past the liveness window and another copy took the sandbox over,
 * must not record its container). The caller stands down on `false`. The
 * connection columns are cleared so any channel the previous container had
 * stops counting at once.
 */
export const recordSpawn = async (
  runnerId: string,
  replicaId: string,
  sandboxId: string,
  spawn: { containerRef: string; tokenHash: string },
): Promise<boolean> => {
  const count = await db.$executeRaw`
    UPDATE sandboxes
    SET container_ref = ${spawn.containerRef},
        channel_token_hash = ${spawn.tokenHash},
        channel_replica_id = NULL,
        channel_connection_id = NULL,
        channel_since = now()
    WHERE id = ${sandboxId}
      AND runner_id = ${runnerId}
      AND owner_replica_id = ${replicaId}
      AND status = 'starting'
  `;
  return count > 0;
};

/**
 * A copy takes a supervisor's control channel as its socket opens.
 *
 * The TOKEN door uses the bootstrap token up atomically (one UPDATE clears
 * the hash, so two copies racing the same token cannot both win) and
 * answers the sandbox and container it was minted for (a token hash only
 * ever exists beside the container `recordSpawn` wrote with it).
 *
 * The SESSION door has already been verified by the copy (an HMAC over the
 * sandbox and container); here it is applied only where that container is
 * still the sandbox's current one and no newer spawn waits for its first
 * connect, so a container that was replaced can never take the channel.
 *
 * Both doors refuse a claim older than the connection already holding the
 * channel (`connectedAt`), so a claim that was retried late can never take
 * the channel back from a newer socket. A claim signals the poll: work that
 * waited while the channel was between copies is dispatchable now.
 */
export const claimChannel = async (
  runnerId: string,
  replicaId: string,
  claim: RunnerChannelClaimRequest,
): Promise<RunnerChannelClaimResponse | null> => {
  const connectedAt = new Date(claim.connectedAt);
  const notOlderThanHolder = Prisma.sql`(
    channel_connection_id IS NULL OR channel_since <= ${connectedAt}
  )`;
  const rows =
    claim.door === "token"
      ? await db.$queryRaw<{ id: string; container_ref: string }[]>`
          UPDATE sandboxes
          SET channel_token_hash = NULL,
              channel_replica_id = ${replicaId},
              channel_connection_id = ${claim.connectionId},
              channel_since = ${connectedAt}
          WHERE channel_token_hash = ${claim.tokenHash}
            AND runner_id = ${runnerId}
          RETURNING id, container_ref
        `
      : await db.$queryRaw<{ id: string; container_ref: string }[]>`
          UPDATE sandboxes
          SET channel_replica_id = ${replicaId},
              channel_connection_id = ${claim.connectionId},
              channel_since = ${connectedAt}
          WHERE id = ${claim.sandboxId}
            AND runner_id = ${runnerId}
            AND container_ref = ${claim.containerRef}
            AND channel_token_hash IS NULL
            AND ${notOlderThanHolder}
          RETURNING id, container_ref
        `;
  const row = rows[0];
  if (!row) return null;
  signalWork();
  return { sandboxId: row.id, containerRef: row.container_ref };
};

/**
 * A copy's socket closed. Applied only while that connection still holds
 * the channel, so a late release after the supervisor reattached elsewhere
 * changes nothing. The copy stays recorded (with the drop time) until a
 * reconnect claims the channel, which is what lets the reconciler tell a
 * reconnecting sandbox from a dead one.
 */
export const releaseChannel = async (
  runnerId: string,
  replicaId: string,
  connectionId: string,
): Promise<void> => {
  await db.$executeRaw`
    UPDATE sandboxes
    SET channel_connection_id = NULL,
        channel_since = now()
    WHERE channel_connection_id = ${connectionId}
      AND channel_replica_id = ${replicaId}
      AND runner_id = ${runnerId}
  `;
};

interface ChannelRow {
  id: string;
  status: string;
  container_ref: string | null;
  channel_replica_id: string | null;
  channel_connection_id: string | null;
  channel_token_hash: string | null;
  channel_since: Date | null;
  holder_last_seen_at: Date | null;
  holder_retired_at: Date | null;
}

/** One sandbox's channel state, from its row and its holder's liveness. */
const channelStateOf = (
  row: ChannelRow,
): { channel: RunnerChannelState; since: Date | null } => {
  if (row.channel_token_hash !== null) {
    return { channel: "awaiting", since: row.channel_since };
  }
  if (row.channel_replica_id === null) {
    // Nothing recorded since the start claim cleared the columns: the spawn
    // is still being created, or (no row state at all) a container from
    // before channel records.
    return row.status === "starting"
      ? { channel: "starting", since: null }
      : { channel: "none", since: null };
  }
  const holderSeen = row.holder_last_seen_at;
  if (
    holderSeen === null ||
    !isLiveReplica({ lastSeenAt: holderSeen, retiredAt: row.holder_retired_at })
  ) {
    // Lost since the holder retired (its later calls still touch its
    // heartbeat, which must not keep pushing the grace out), else since it
    // was last heard from.
    return {
      channel: "lost",
      since: row.holder_retired_at ?? holderSeen,
    };
  }
  return row.channel_connection_id !== null
    ? { channel: "held", since: row.channel_since }
    : { channel: "dropped", since: row.channel_since };
};

export interface RunnerSandboxListing {
  rows: Array<{ id: string; status: string }>;
  channels: Record<string, RunnerSandboxChannel>;
  /** Whether the asking copy is the runner's reconciler (always, for a
   * single-process runner). */
  reconciler: boolean;
}

/**
 * The runner's reconciler: its OLDEST live copy. Deterministic, needs no
 * lease or extra write, and passes to the next oldest within one liveness
 * window when it dies. One definition, read by the listing and by a copy's
 * own role read. One indexed row (`runner_replicas (runner_id,
 * last_seen_at)`), never the sandbox table.
 */
const oldestLiveReplicaSql = (runnerId: string) => db.$queryRaw<
  { id: string }[]
>`
  SELECT r.id FROM runner_replicas r
  WHERE r.runner_id = ${runnerId} AND ${liveReplicaSql(Prisma.sql`r`)}
  ORDER BY r.created_at ASC, r.id ASC
  LIMIT 1
`;

/** Whether `replicaId` is its runner's reconciler (the oldest live copy). */
export const isReconcilerReplica = async (
  runnerId: string,
  replicaId: string,
): Promise<boolean> =>
  (await oldestLiveReplicaSql(runnerId))[0]?.id === replicaId;

/**
 * The reconcile truth: every sandbox this runner should host (the reap
 * authority: anything labeled ours and absent is destroyed), what the
 * control plane believes about each (the status feeds the vanished-pod arm;
 * the channel facts tell a booting or reconnecting sandbox from a gone one,
 * whichever copy holds its socket), and whether the asking copy is the
 * reconciler (`isReconcilerReplica`'s rule).
 */
export const listRunnerSandboxes = async (
  runnerId: string,
  replicaId: string | undefined,
): Promise<RunnerSandboxListing> => {
  const [rows, oldest] = await Promise.all([
    db.$queryRaw<ChannelRow[]>`
      SELECT s.id, s.status, s.container_ref, s.channel_replica_id,
             s.channel_connection_id, s.channel_token_hash, s.channel_since,
             r.last_seen_at AS holder_last_seen_at,
             r.retired_at AS holder_retired_at
      FROM sandboxes s
      LEFT JOIN runner_replicas r ON r.id = s.channel_replica_id
      WHERE s.runner_id = ${runnerId}
    `,
    replicaId === undefined
      ? Promise.resolve([])
      : oldestLiveReplicaSql(runnerId),
  ]);
  const channels: Record<string, RunnerSandboxChannel> = {};
  for (const row of rows) {
    const { channel, since } = channelStateOf(row);
    channels[row.id] = {
      containerRef: row.container_ref,
      channel,
      since: since ? since.getTime() : null,
    };
  }
  return {
    rows: rows.map((row) => ({ id: row.id, status: row.status })),
    channels,
    reconciler: replicaId === undefined || oldest[0]?.id === replicaId,
  };
};

/**
 * Claim the stop of a stray: a container still running although its
 * sandbox is parked. `stopped`/`failed` → `stopping`, only while that
 * container is still the sandbox's and the lifecycle is free for this copy
 * (unowned, its own, or its owner dead), so a start that got there first
 * (on any copy) wins and the stray stop stands down. The claim takes
 * ownership like any lifecycle claim; the ordinary stop report settles it.
 */
export const claimStrayStop = async (
  runnerId: string,
  replicaId: string,
  sandboxId: string,
  containerRef: string,
): Promise<boolean> => {
  const count = await db.$executeRaw`
    UPDATE sandboxes s
    SET status = 'stopping', updated_at = now(), owner_replica_id = ${replicaId}
    WHERE s.id = ${sandboxId}
      AND s.runner_id = ${runnerId}
      AND s.container_ref = ${containerRef}
      AND s.status IN ('stopped', 'failed')
      ${lifecycleFreeFor(replicaId)}
  `;
  return count > 0;
};

/**
 * A copy shutting down cleanly gives up its identity at once, the way a
 * lease is revoked rather than left to expire: the sandboxes it owned and
 * the channels it held hand over to the other copies immediately instead of
 * after the liveness window, the next oldest copy becomes the reconciler,
 * and it is handed no new work. One-way and set once: its own later calls
 * (socket releases, final reports) still touch its heartbeat but never make
 * it live again, and the first retirement stays the moment its sockets read
 * `lost` from (the reconciler's grace for those supervisors to reconnect
 * elsewhere). The row itself stays (it is history for the channel and owner
 * records) until the day-old cleanup at registration.
 */
export const retireReplica = async (
  runnerId: string,
  replicaId: string,
): Promise<void> => {
  const count = await db.$executeRaw`
    UPDATE runner_replicas
    SET retired_at = now()
    WHERE id = ${replicaId} AND runner_id = ${runnerId} AND retired_at IS NULL
  `;
  // Its sandboxes are claimable by the other copies from this moment: wake
  // their held polls rather than leaving the work for the next re-check.
  if (count > 0) signalWork();
};

/**
 * Whether a copy of this runner has retired. Its own poll parked on the
 * server when it retired asks this on the retire's wake and answers at once:
 * it will be handed nothing anyway (the claim fences refuse it), and its
 * shutdown is waiting for that poll.
 */
export const isReplicaRetired = async (
  runnerId: string,
  replicaId: string,
): Promise<boolean> => {
  const replica = await db.runnerReplica.findFirst({
    where: { id: replicaId, runnerId, retiredAt: { not: null } },
    select: { id: true },
  });
  return replica !== null;
};
