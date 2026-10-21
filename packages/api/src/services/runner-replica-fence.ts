import { Prisma } from "@onecli/db";
import { onlineSince } from "./placement";

/**
 * The SQL fragments that decide which runner copy may act on a sandbox, in
 * one place, so the work claim and every other lifecycle claim apply the
 * same rule. All of them expect the sandbox row aliased as `s`. With no copy
 * id (a single-process runner) each is empty: one process needs no fence.
 */

/** Liveness of one copy row aliased `alias`: its heartbeat is inside the
 * runner online window and it has not retired. Retirement is one-way: the
 * copy's own last calls after it (socket releases, final reports) still
 * touch its heartbeat, and must never make it live again. */
export const liveReplicaSql = (alias: Prisma.Sql): Prisma.Sql =>
  Prisma.sql`(${alias}.last_seen_at >= ${onlineSince()} AND ${alias}.retired_at IS NULL)`;

/** The same rule over a row already read (the preview route reads the
 * holder through Prisma). One definition of "live", in two shapes. */
export const isLiveReplica = (replica: {
  lastSeenAt: Date;
  retiredAt: Date | null;
}): boolean =>
  replica.retiredAt === null && replica.lastSeenAt >= onlineSince();

/**
 * A copy that has retired is handed nothing new (the Temporal lesson: a
 * worker on its way out must not be given work it will never run). Its poll
 * already in flight when it retired, and any claim after, find nothing; the
 * work stays due for the other copies.
 */
const callerNotRetired = (replicaId: string): Prisma.Sql =>
  Prisma.sql`AND NOT EXISTS (
    SELECT 1 FROM runner_replicas me
    WHERE me.id = ${replicaId} AND me.retired_at IS NOT NULL
  )`;

/**
 * One sandbox's lifecycle steps (start, stop, evict, stray stop) run one at
 * a time on one copy. A copy may claim the next step only when the sandbox
 * has no owner, is its own, or its owner stopped heartbeating, so a dead
 * copy hands over within the liveness window. This is a controller
 * workqueue's per-key serialization (never the same key on two workers),
 * done inside the claim: without it, a respawn could hand a second start to
 * another copy while the first is still creating, and one would remove the
 * other's container.
 */
export const lifecycleFreeFor = (replicaId: string | undefined): Prisma.Sql =>
  replicaId === undefined
    ? Prisma.empty
    : Prisma.sql`AND (
        s.owner_replica_id IS NULL
        OR s.owner_replica_id = ${replicaId}
        OR NOT EXISTS (
          SELECT 1 FROM runner_replicas o
          WHERE o.id = s.owner_replica_id AND ${liveReplicaSql(Prisma.sql`o`)}
        )
      )
      ${callerNotRetired(replicaId)}`;

/** The SET fragment a lifecycle claim adds: the claiming copy becomes the
 * sandbox's owner. Leading comma included. */
export const takeOwnership = (replicaId: string | undefined): Prisma.Sql =>
  replicaId === undefined
    ? Prisma.empty
    : Prisma.sql`, owner_replica_id = ${replicaId}`;

/**
 * The arms whose work only means something on the sandbox's control socket
 * (deliver, abort, steer, send-now, home sync, the ceiling warning) are
 * claimed only by the copy holding that socket, and only while it is open:
 * any other copy (or the holder after its socket closed) would find no
 * socket, and the work would be lost or misread as a dead sandbox. Work for
 * a sandbox whose channel is between sockets waits until the supervisor
 * reattaches, and the reattach signals the poll.
 */
export const channelHeldBy = (replicaId: string | undefined): Prisma.Sql =>
  replicaId === undefined
    ? Prisma.empty
    : Prisma.sql`AND s.channel_replica_id = ${replicaId}
        AND s.channel_connection_id IS NOT NULL
        ${callerNotRetired(replicaId)}`;
