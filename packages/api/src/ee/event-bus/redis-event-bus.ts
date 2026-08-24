import type { Redis } from "ioredis";
import { logger } from "../../lib/logger";
import {
  createInProcessEventBus,
  type EventBus,
  type PublishedEvent,
} from "../../services/event-bus";

const log = logger.child({ component: "event-bus-redis" });

/**
 * The cloud live fan-out bus (plans/sandbox-platform-issues.md "EventBus
 * cross-instance fan-out"). The api-server runs multiple pods; the runner's
 * event POST and a browser's SSE stream land on independently-chosen pods, so
 * an in-process emitter delivers a publish to no one when they differ. This
 * bus carries every publish over Redis pub/sub, so a publish on any pod
 * reaches the SSE stream on whichever pod holds it.
 *
 * Injected as the cloud edition default (`edition-defaults.ts`) — shared code
 * never imports it (ioredis stays out of every client bundle). Onprem keeps
 * the in-process emitter, which one api instance is exactly right for.
 *
 * Contract inherited from the seam: this is a LATENCY OPTIMIZATION, not a
 * delivery guarantee. Postgres is the truth and the SSE stream reads history
 * on (re)connect, so a dropped publish costs at most one reconnect. That is
 * what lets this tolerate a Redis blip, and it is why the async-SUBSCRIBE
 * window below is safe.
 */

const CHANNEL_PREFIX = "api:evt:";
const channelFor = (conversationId: string): string =>
  `${CHANNEL_PREFIX}${conversationId}`;
const conversationOf = (channel: string): string | null =>
  channel.startsWith(CHANNEL_PREFIX)
    ? channel.slice(CHANNEL_PREFIX.length)
    : null;

export interface RedisEventBusDeps {
  /** A normal command connection — PUBLISH is legal on it (reuse the shared
   * singleton). */
  publisher: Pick<Redis, "publish">;
  /** A DEDICATED connection: ioredis forbids commands on a connection in
   * subscriber mode, so this must be its own `.duplicate()`, used only here. */
  subscriber: Pick<Redis, "subscribe" | "unsubscribe" | "on">;
}

export const createRedisEventBus = (deps: RedisEventBusDeps): EventBus => {
  // The local fan-out half is the exact in-process emitter — same delivery,
  // same throwing-listener isolation, same map-leak guard, same test seams.
  // This bus only adds the Redis hop between pods.
  const local = createInProcessEventBus();

  // channel → the pending-or-acked SUBSCRIBE promise. Presence here — not the
  // local subscriber count — is what gates issuing a SUBSCRIBE: a count-based
  // gate ("first subscriber talks to Redis") has two holes that only differ
  // from the recorded "a blip costs a reconnect" contract by never healing:
  // a later subscriber arriving inside the SUBSCRIBE round-trip would treat
  // in-flight as acked, and a REJECTED subscribe would leave the count > 0
  // with no one ever re-issuing the command (ioredis auto-resubscribes only
  // channels whose SUBSCRIBE succeeded).
  const established = new Map<string, Promise<void>>();

  // One inbound handler for the whole subscriber connection: parse the
  // conversation off the channel and hand the batch to the local emitter,
  // which owns the try/per-listener isolation.
  deps.subscriber.on("message", (channel: string, payload: string) => {
    const conversationId = conversationOf(channel);
    if (!conversationId) return;
    let events: PublishedEvent[];
    try {
      events = JSON.parse(payload) as PublishedEvent[];
    } catch (err) {
      log.warn({ err, channel }, "dropping unparseable pub/sub payload");
      return;
    }
    local.publish(conversationId, events);
  });
  // A subscriber-connection error must never crash the process; ioredis
  // auto-reconnects and auto-resubscribes its channel set, so the only cost
  // is the events in the gap — which history heals.
  deps.subscriber.on("error", (err: Error) => {
    log.warn({ err }, "event-bus subscriber connection error");
  });

  return {
    publish(conversationId, events) {
      if (events.length === 0) return;
      // NEVER throw: the publisher is on the runner's critical path. A Redis
      // failure degrades to "the tail reconnects and replays history".
      try {
        void deps.publisher
          .publish(channelFor(conversationId), JSON.stringify(events))
          .catch((err: unknown) => {
            log.warn({ err, conversationId }, "event publish failed");
          });
      } catch (err) {
        log.warn({ err, conversationId }, "event publish threw");
      }
    },

    subscribe(conversationId, listener) {
      // Register locally FIRST and synchronously. Only a channel with no
      // (pending or acked) SUBSCRIBE talks to Redis, so a pod holds exactly
      // the channels it is actually tailing — never every conversation
      // fleet-wide.
      const localSub = local.subscribe(conversationId, listener);
      const channel = channelFor(conversationId);

      // `ready` settles once the SUBSCRIBE is ACKED — the caller awaits it
      // before reading a history snapshot, so no committed+published event
      // can fall between an un-acked subscription and the snapshot. EVERY
      // local subscriber shares the same ack promise: "a subscribe is in
      // flight" is not "acked", so a second tab arriving inside the SUBSCRIBE
      // round-trip must wait for the same ack, not sail past it.
      //
      // A rejected SUBSCRIBE must not leave the channel silently deaf:
      // nothing else would ever retry it — the SSE keep-alives keep flowing,
      // so no client reconnects on its own. So the failure is (a) surfaced:
      // `ready` rejects, the stream it belongs to closes, and the browser's
      // EventSource retries on its backoff; and (b) forgotten: the next
      // subscriber re-issues the SUBSCRIBE instead of finding a poisoned
      // entry.
      let ack = established.get(channel);
      if (!ack) {
        const attempt: Promise<void> = toPromise(
          deps.subscriber.subscribe(channel),
        ).then(
          () => undefined,
          (err: unknown) => {
            if (established.get(channel) === attempt) {
              established.delete(channel);
            }
            log.warn(
              { err, conversationId },
              "event-bus channel subscribe failed",
            );
            throw err instanceof Error ? err : new Error(String(err));
          },
        );
        // The stored promise may reject after its last awaiter released —
        // that must never surface as an unhandled rejection.
        attempt.catch(() => undefined);
        established.set(channel, attempt);
        ack = attempt;
      }
      const ready = ack;

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        localSub.release();
        // Last local tailer gone → stop carrying this channel on this pod.
        // Forgetting the ack entry here is what lets a later 0→1 transition
        // re-issue the SUBSCRIBE (ioredis serializes the UNSUBSCRIBE and any
        // later SUBSCRIBE on the one connection, so the end state is right).
        if (local.subscriberCount(conversationId) === 0) {
          established.delete(channel);
          void toPromise(deps.subscriber.unsubscribe(channel)).catch(
            (err: unknown) => {
              log.warn(
                { err, conversationId },
                "event-bus channel unsubscribe failed",
              );
            },
          );
        }
      };
      return { release, ready };
    },

    subscriberCount: (conversationId) => local.subscriberCount(conversationId),
    trackedConversationCount: () => local.trackedConversationCount(),
  };
};

// ioredis subscribe/unsubscribe return a Promise; normalize so a fake or a
// sync stub is handled uniformly.
const toPromise = (value: unknown): Promise<unknown> =>
  value instanceof Promise ? value : Promise.resolve(value);
