import { randomUUID } from "node:crypto";
import { db, Prisma } from "@onecli/db";
import { leaseExpiry, whileLeased } from "../../lib/lease";
import { agentImageUrlOrNull } from "../agent-image-service";
import { decryptCached } from "./channel-decrypt-cache";
import { EventInFlightError } from "./channel-ingestion-service";
import { publicApiUrl } from "./posture";
import { channelProvider, isChannelProviderId } from "./registry";
import { logger } from "../../lib/logger";

const log = logger.child({ component: "channel-inbound-events" });

/**
 * The durable inbox of every provider's HTTP events transport
 * (`channel_inbound_events`).
 *
 * A provider that pushes events over HTTP wants a fast 2xx and redelivers
 * when it does not get one (Slack: within three seconds, three retries over
 * about five minutes). Processing an event can take far longer: a message's
 * files are fetched before its turn is created. So the provider's events
 * route only verifies the request, accepts the event here and answers; the
 * event is processed right after, off the request, by the replica that
 * accepted it, through the provider's own `dispatchInbound` and
 * `replyToOutcome`.
 *
 * The row is the delivery guarantee. It is written already CLAIMED by the
 * accepting replica (a lease, not a lock: no transaction is held while the
 * event is processed), renewed while processing runs, and deleted when it
 * finishes. A replica that dies mid-event leaves the row behind; once its
 * lease lapses, the recovery pass on any replica claims it again
 * (`FOR UPDATE SKIP LOCKED`, so two replicas never take the same row). A
 * failure is retried with backoff up to `MAX_ATTEMPTS`, then dropped with
 * an error log; `expiresAt` bounds every row's life regardless.
 *
 * Re-processing is safe because the ingestion doors run every event through
 * their own claim ledger (`channel_ingested_events`): a settled event
 * answers `duplicate`, an event another run is still processing is retried
 * later, and a run that died after its turn committed is found by the turn
 * it created, never doubled.
 */

/** Tries per event (the first included) before it is dropped. */
const MAX_ATTEMPTS = 5;
/** Backoff before the Nth retry: 30s, 1m, 2m, 4m. */
const retryDelayMs = (attempts: number): number =>
  30_000 * 2 ** Math.max(0, attempts - 1);
/** A row's whole life: far past the last retry, short enough to never pile up. */
const RETENTION_MS = 24 * 60 * 60 * 1000;
/** Events one replica processes concurrently right after accepting them.
 * Past it an accepted event waits for the recovery pass instead of piling
 * more fetches onto an already busy process. */
const MAX_IN_FLIGHT = 32;
/** Rows one recovery pass claims. */
const RECOVERY_BATCH = 25;
/** The recovery pass cadence (per replica; claims make overlap harmless). */
const RECOVERY_INTERVAL_MS = 30 * 1000;

let inFlight = 0;
const running = new Set<Promise<void>>();

interface InboundClaim {
  id: string;
  claimToken: string;
}

/**
 * Write one verified event, claimed by this replica. Null when the event is
 * already in the inbox (a provider redelivery while the first is pending).
 */
export const acceptInboundEvent = async (input: {
  presenceId: string;
  eventId: string;
  event: Prisma.InputJsonValue;
}): Promise<InboundClaim | null> => {
  const claimToken = randomUUID();
  const now = Date.now();
  try {
    const row = await db.channelInboundEvent.create({
      data: {
        agentChannelId: input.presenceId,
        eventId: input.eventId,
        event: input.event,
        attempts: 1,
        claimToken,
        claimExpiresAt: leaseExpiry(now),
        expiresAt: new Date(now + RETENTION_MS),
      },
      select: { id: true },
    });
    return { id: row.id, claimToken };
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return null;
    }
    throw err;
  }
};

/**
 * Process an accepted event off the request. Over the in-flight bound the
 * claim is released instead, so the recovery pass picks the event up.
 */
export const processInboundEventDetached = (claim: InboundClaim): void => {
  if (inFlight >= MAX_IN_FLIGHT) {
    void releaseClaim(claim).catch((err: unknown) =>
      log.warn({ err, id: claim.id }, "inbound event claim release failed"),
    );
    return;
  }
  inFlight += 1;
  const settled = processClaimed(claim)
    .catch((err: unknown) =>
      log.error({ err, id: claim.id }, "inbound event processing crashed"),
    )
    .finally(() => {
      inFlight -= 1;
      running.delete(settled);
    });
  running.add(settled);
};

/**
 * The recovery pass: claim rows whose lease lapsed (a replica died, or the
 * in-flight bound deferred them) and whose retry time has come, and process
 * them. Expired and exhausted rows are dropped first.
 */
export const recoverInboundEvents = async (): Promise<number> => {
  const now = new Date();
  const dropped = await db.channelInboundEvent.deleteMany({
    where: {
      OR: [{ expiresAt: { lte: now } }, { attempts: { gte: MAX_ATTEMPTS } }],
      AND: [
        {
          OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lt: now } }],
        },
      ],
    },
  });
  if (dropped.count > 0) {
    log.error(
      { count: dropped.count },
      "inbound events dropped after their last attempt",
    );
  }

  let recovered = 0;
  for (let i = 0; i < RECOVERY_BATCH; i += 1) {
    const claimToken = randomUUID();
    const claimedAt = new Date();
    const until = leaseExpiry(claimedAt.getTime());
    const rows = await db.$queryRaw<{ id: string }[]>`
      WITH candidate AS (
        SELECT id FROM channel_inbound_events
        WHERE next_attempt_at <= (${claimedAt}::timestamptz AT TIME ZONE 'UTC')
          AND expires_at > (${claimedAt}::timestamptz AT TIME ZONE 'UTC')
          AND attempts < ${MAX_ATTEMPTS}
          AND (claim_expires_at IS NULL
            OR claim_expires_at < (${claimedAt}::timestamptz AT TIME ZONE 'UTC'))
        ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE channel_inbound_events e
      SET claim_token = ${claimToken},
          claim_expires_at = (${until}::timestamptz AT TIME ZONE 'UTC'),
          attempts = attempts + 1
      FROM candidate WHERE e.id = candidate.id RETURNING e.id`;
    const id = rows[0]?.id;
    if (!id) break;
    await processClaimed({ id, claimToken });
    recovered += 1;
  }
  return recovered;
};

/** Test seam: resolve once every detached processing run has settled. */
export const settleInboundEventsForTests = async (): Promise<void> => {
  while (running.size > 0) await Promise.allSettled([...running]);
};

/**
 * Run the recovery pass at boot and every `RECOVERY_INTERVAL_MS` in this
 * process. Every replica runs one: claims are row-level, so replicas never
 * take the same event, and an idle pass is one indexed query. A pass still
 * running when the next tick fires is not overlapped.
 */
export const startInboundEventRecovery = (): NodeJS.Timeout => {
  let passing = false;
  const pass = () => {
    if (passing) return;
    passing = true;
    void recoverInboundEvents()
      .then((recovered) => {
        if (recovered > 0) log.info({ recovered }, "inbound events recovered");
      })
      .catch((err: unknown) =>
        log.warn({ err }, "inbound event recovery pass failed"),
      )
      .finally(() => {
        passing = false;
      });
  };
  pass();
  const timer = setInterval(pass, RECOVERY_INTERVAL_MS);
  timer.unref();
  return timer;
};

const fence = (claim: InboundClaim) => ({
  id: claim.id,
  claimToken: claim.claimToken,
});

const releaseClaim = (claim: InboundClaim) =>
  db.channelInboundEvent.updateMany({
    where: fence(claim),
    data: { claimToken: null, claimExpiresAt: null },
  });

const processClaimed = async (claim: InboundClaim): Promise<void> => {
  const row = await db.channelInboundEvent.findFirst({
    where: { ...fence(claim), claimExpiresAt: { gt: new Date() } },
    select: {
      agentChannelId: true,
      eventId: true,
      event: true,
      attempts: true,
    },
  });
  // Another replica took it over (this claim's lease lapsed first).
  if (!row) return;

  try {
    await whileLeased(
      {
        renew: () =>
          db.channelInboundEvent.updateMany({
            where: fence(claim),
            data: { claimExpiresAt: leaseExpiry() },
          }),
        onRenewError: (err) =>
          log.warn({ err, id: claim.id }, "inbound event lease renewal failed"),
      },
      () => dispatchAndReply(row),
    );
    await db.channelInboundEvent.deleteMany({ where: fence(claim) });
  } catch (err) {
    const last = row.attempts >= MAX_ATTEMPTS;
    // Another run holds the event's ingest claim: a retry, not a failure.
    const inFlightElsewhere = err instanceof EventInFlightError;
    log[last ? "error" : inFlightElsewhere ? "info" : "warn"](
      { err, id: claim.id, eventId: row.eventId, attempts: row.attempts },
      last
        ? "inbound event failed its last attempt; dropped"
        : "inbound event will be retried",
    );
    await (
      last
        ? db.channelInboundEvent.deleteMany({ where: fence(claim) })
        : db.channelInboundEvent.updateMany({
            where: fence(claim),
            data: {
              claimToken: null,
              claimExpiresAt: null,
              nextAttemptAt: new Date(Date.now() + retryDelayMs(row.attempts)),
            },
          })
    ).catch((writeErr: unknown) =>
      log.warn(
        { err: writeErr, id: claim.id },
        "inbound event retry bookkeeping failed; its lease will lapse",
      ),
    );
  }
};

/**
 * One event through its provider: the same dispatch the socket transport
 * uses, then the replies the outcome owes. A presence that is gone,
 * detached or disabled since the event was accepted drops it unprocessed:
 * its events are a stranger's now (the lifecycle fence the route applies on
 * entry).
 */
const dispatchAndReply = async (row: {
  agentChannelId: string;
  eventId: string;
  event: Prisma.JsonValue;
}): Promise<void> => {
  const presence = await db.agentChannel.findUnique({
    where: { id: row.agentChannelId },
    select: {
      provider: true,
      status: true,
      identityRef: true,
      credentials: true,
      agent: { select: { id: true, imageKey: true } },
    },
  });
  if (
    !presence ||
    (presence.status !== "active" && presence.status !== "needs_attention") ||
    !isChannelProviderId(presence.provider)
  ) {
    return;
  }
  const provider = channelProvider(presence.provider);
  const result = await provider.dispatchInbound({
    presenceId: row.agentChannelId,
    identityRef: presence.identityRef,
    event: row.event,
    eventId: row.eventId,
  });
  if (!provider.replyToOutcome || !presence.credentials) return;
  await provider.replyToOutcome({
    credentialsJson: await decryptCached(presence.credentials),
    // A provider can never fetch a localhost/plain-http icon_url.
    iconUrl:
      publicApiUrl() !== null
        ? agentImageUrlOrNull(presence.agent.id, presence.agent.imageKey)
        : null,
    result,
  });
};
