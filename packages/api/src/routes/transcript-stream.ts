import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { type PublishedEvent } from "../services/event-bus";
import { getEventBus } from "../providers/event-bus";
import { logger } from "../lib/logger";

const log = logger.child({ component: "transcript-stream" });

/**
 * The SSE transcript tail, factored out of `routes/conversations.ts` — the
 * web chat's stream: "history first, then tail", one `transcript` event
 * name, `seq` as the SSE id, keep-alive comments. Kept as its own module so
 * a future second consumer inherits the identical contract; the caller owns
 * authorization and the history fence.
 *
 * Callers authorize BEFORE invoking this (so a refusal is an ordinary status
 * code, not an empty 200), then hand over a `readHistory` closure that carries
 * their own fence.
 */

/**
 * How often the stream emits a keep-alive. Must stay under the tightest hop:
 * CloudFront's 60s origin response timeout caps the gap between packets, and
 * the ALB's 60s idle timeout needs at least one byte (it does not count
 * HTTP/2 PINGs). 15s is the WHATWG suggestion and leaves 4x margin.
 *
 * It is also the connection's dead-peer detector, which is why it runs even
 * on a busy stream: hono's `write` swallows its own errors, so a failed write
 * never throws — `stream.aborted` is the loop's ONLY exit, and that is set by
 * the abort path this write provokes.
 */
const HEARTBEAT_MS = 15_000;

/**
 * An SSE COMMENT (`:` + text), not an event. Comments keep every proxy hop
 * from calling the connection idle without the client dispatching anything —
 * a named `heartbeat` event would wake every reader four times a minute for
 * nothing.
 */
const KEEP_ALIVE = ": keep-alive\n\n";

/** One replay page. The transcript endpoint's own maximum. */
const HISTORY_PAGE_SIZE = 500;

/**
 * How many pages a reconnect will replay before it starts tailing regardless.
 * A backstop, not a budget: 100 × 500 is far more than any real conversation
 * holds, and the alternative to a bound is a client that can pin a connection
 * replaying forever.
 */
const HISTORY_PAGE_LIMIT = 100;

/**
 * How far the live tail may fall behind before the connection is cut.
 *
 * A reader that stops consuming (a suspended laptop, a wedged proxy) blocks
 * the write loop, and the subscriber keeps appending behind it. Dropping the
 * connection is the RIGHT answer rather than a lossy one: history is
 * authoritative, so the client reconnects with its last seq and gets the gap
 * back — which is exactly the guarantee `event-bus.ts` is built on ("a dropped
 * publish costs a reconnect, never an event").
 */
const MAX_PENDING_EVENTS = 1_000;

/**
 * How long a single frame may sit unconsumed before the reader is cut loose.
 * Generous next to the 15s keep-alive — this is for a peer that has stopped
 * reading altogether, not one that is merely slow.
 */
const WRITE_STALL_MS = 30_000;

/** One page of durable transcript, as `readTranscript` returns it. */
export interface TranscriptPage {
  events: {
    seq: number;
    turnId: string;
    type: string;
    payload: unknown;
  }[];
  nextSince: number;
  hasMore: boolean;
}

export interface StreamTranscriptOptions {
  conversationId: string;
  /** The cursor the client resumed from (`?since=` or `Last-Event-ID`). */
  since?: number;
  /**
   * One fenced page of history. The closure carries the caller's own
   * authorization — the public route fences by workspace + direct-thread owner,
   * the adapter route by its link ownership.
   */
  readHistory: (params: {
    since?: number;
    limit?: number;
  }) => Promise<TranscriptPage>;
}

export const streamTranscript = (
  c: Context,
  { conversationId, since, readHistory }: StreamTranscriptOptions,
) => {
  // Nginx buffers proxied responses by default and `Cache-Control: no-cache`
  // does not change that — this header is the switch. Without it every
  // self-hosted install behind nginx (the common onprem shape) gets a
  // stream that still "works" and is no longer live, which is the failure
  // mode hardest to notice. CloudFront's half is handled in the CDK.
  c.header("X-Accel-Buffering", "no");

  return streamSSE(
    c,
    async (stream) => {
      const pending: PublishedEvent[] = [];
      /** Set while the loop is parked; calling it delivers immediately. */
      let wake: (() => void) | undefined;
      /** The highest seq this connection has written. Only ever advances. */
      let lastSeq = 0;

      /**
       * SUBSCRIBE FIRST, then read history.
       *
       * The other order has a hole: an event published between the history
       * read and the subscribe reaches no one, and because `lastSeq` only
       * moves forward it would be skipped for the life of the connection —
       * a gap that only a reconnect heals. Buffering from before the
       * snapshot and discarding what the snapshot already covered closes it,
       * and costs nothing: the overlap is exactly what the `seq` dedupe
       * below is for.
       */
      /** Set when the reader fell too far behind to keep buffering. */
      let overflowed = false;

      const subscription = getEventBus().subscribe(conversationId, (events) => {
        if (pending.length + events.length > MAX_PENDING_EVENTS) {
          overflowed = true;
          pending.length = 0;
          wake?.();
          return;
        }
        pending.push(...events);
        wake?.();
      });
      const release = subscription.release;
      // Released on every exit path: a closed tab must not leak a listener.
      // Waking too, so the loop notices and exits instead of sitting parked
      // on the heartbeat timer still holding its subscription.
      stream.onAbort(() => {
        release();
        wake?.();
      });

      /**
       * Write, or give up on this reader.
       *
       * `overflowed` alone cannot end the connection: the loop discovers it
       * only when it comes back round, and a reader that has stopped
       * consuming entirely leaves the loop parked inside `writeSSE` — hono's
       * transform stream resolves a write only when the consumer pulls. The
       * suspended laptop and the wedged proxy, the two cases the buffer cap
       * names, are exactly the ones a flag cannot reach.
       *
       * So the write races a deadline, and losing aborts the stream: that
       * sets `aborted`, which releases the subscription and ends the loop.
       * Nothing is lost by cutting — history is authoritative and the client
       * resumes from its last seq.
       */
      const writeOrCut = async (frame: () => Promise<unknown>) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stalled = new Promise<"stalled">((resolve) => {
          timer = setTimeout(() => resolve("stalled"), WRITE_STALL_MS);
          timer.unref?.();
        });
        const outcome = await Promise.race([
          frame().then(() => "ok" as const),
          stalled,
        ]);
        if (timer) clearTimeout(timer);
        if (outcome === "stalled") {
          log.warn(
            { conversationId, lastSeq },
            "stream reader stopped consuming; cutting it loose",
          );
          stream.abort();
        }
      };

      /**
       * Park until something is published, or the heartbeat falls due —
       * whichever comes first. Resolves true when woken by a publish.
       *
       * This is a WAIT, deliberately not a poll: sleeping the heartbeat
       * interval and checking afterwards would put up to `HEARTBEAT_MS` of
       * latency in front of every token, which is the entire thing a live
       * stream exists to avoid.
       */
      const waitForPublish = (): Promise<boolean> =>
        new Promise((resolve) => {
          // Checked synchronously, which closes the race: `publish` runs its
          // listeners synchronously, so anything that arrived between the
          // drain and here is already in `pending` and would otherwise sit
          // there unnoticed until the heartbeat.
          if (pending.length > 0) {
            resolve(true);
            return;
          }
          const timer = setTimeout(() => {
            wake = undefined;
            resolve(false);
          }, HEARTBEAT_MS);
          // Never hold the process open for an idle reader.
          timer.unref?.();
          wake = () => {
            clearTimeout(timer);
            wake = undefined;
            resolve(true);
          };
        });

      /**
       * Replay durable history after `fromCursor`, paged to exhaustion,
       * advancing `lastSeq` past everything written. Two callers: the
       * startup snapshot, and the live drain's gap repair.
       *
       * PAGED TO EXHAUSTION, not one page. `lastSeq` only ever advances,
       * so stopping at the first page would move the cursor past the rest
       * of the backlog and the live tail would never fill it in — the gap
       * would survive until the client reconnected, which is precisely the
       * loss this endpoint exists to prevent. A long turn with many tool
       * calls clears 500 events easily.
       */
      const replayHistory = async (fromCursor: number | undefined) => {
        let cursor = fromCursor;
        for (let page = 0; page < HISTORY_PAGE_LIMIT; page += 1) {
          const history = await readHistory({
            since: cursor,
            limit: HISTORY_PAGE_SIZE,
          });
          for (const event of history.events) {
            await writeOrCut(() =>
              stream.writeSSE({
                id: String(event.seq),
                event: "transcript",
                data: JSON.stringify(event),
              }),
            );
            if (stream.aborted || stream.closed) return;
          }
          lastSeq = Math.max(lastSeq, history.nextSince);
          cursor = history.nextSince;
          if (!history.hasMore) break;
          if (stream.aborted || stream.closed) break;
        }
      };

      // Everything from here on is inside the try, so the subscription is
      // released even if the history read fails.
      try {
        // Wait for the subscription to be genuinely ACTIVE before the history
        // snapshot: with an async bus (Redis), a publish between an un-acked
        // SUBSCRIBE and the snapshot below would be in neither, and lost on a
        // healthy connection until reload. Instant for the in-process bus.
        // A subscribe that FAILS rejects here, which closes the stream — the
        // client's EventSource retries on its backoff, which beats serving a
        // heartbeat-alive stream that is silently deaf.
        // Any live events that arrive during the history read are buffered in
        // `pending` and the `seq <= lastSeq` dedupe drops the overlap.
        await subscription.ready;

        // Everything the client missed, in order, before any live event — so
        // the tail can never arrive ahead of the history it belongs after.
        await replayHistory(Number.isFinite(since) ? since : undefined);

        // One frame up front, so the client — and every proxy between it and
        // here — sees a live stream even when there is no history to replay.
        await writeOrCut(() => stream.write(KEEP_ALIVE));

        while (!stream.aborted && !stream.closed) {
          const woken = await waitForPublish();

          if (overflowed) {
            log.warn(
              { conversationId, lastSeq },
              "stream reader fell behind; closing so it reconnects",
            );
            break;
          }

          while (pending.length > 0) {
            const event = pending.shift();
            // `<= lastSeq` is the dedupe: history and the live tail overlap
            // by design, and a reconnecting reader must not see doubles.
            if (!event || event.seq <= lastSeq) continue;
            // GAP REPAIR. Seqs are contiguous per conversation and every
            // event — deltas included — is published, so a hole in the live
            // tail means a publish was dropped (a Redis blip) or arrived
            // out of order across pods. Advancing `lastSeq` over the hole
            // would make the dedupe hide its durable events for the life of
            // the connection — so read them back first: this event's publish
            // happened after its commit and commits are seq-ordered, so
            // everything below it is already readable. A delta-only hole
            // (deltas are published but never stored) reads back empty and
            // costs one bounded page.
            if (event.seq > lastSeq + 1) {
              await replayHistory(lastSeq);
              // The repair may have replayed this event itself.
              if (event.seq <= lastSeq) continue;
            }
            lastSeq = event.seq;
            await writeOrCut(() =>
              stream.writeSSE({
                id: String(event.seq),
                event: "transcript",
                data: JSON.stringify({
                  seq: event.seq,
                  turnId: event.turnId,
                  type: event.type,
                  payload: event.event,
                }),
              }),
            );
            // An overflow discovered mid-drain must not wait out the park.
            if (overflowed || stream.aborted) break;
          }

          // Nothing came: emit bytes anyway. Invisible to clients, but it is
          // what keeps every proxy hop from calling this connection idle —
          // and what surfaces a peer that has gone away.
          if (!woken && !stream.aborted && !stream.closed) {
            await writeOrCut(() => stream.write(KEEP_ALIVE));
          }
        }
      } finally {
        release();
      }
    },
    async (err, stream) => {
      // Hono's global onError does NOT fire for a stream callback.
      log.error({ err, conversationId }, "conversation stream failed");
      await stream.close();
    },
  );
};
