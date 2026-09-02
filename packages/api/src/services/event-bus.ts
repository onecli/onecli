import type { AgentEvent } from "@onecli/agent-protocol";
import { logger } from "../lib/logger";

const log = logger.child({ component: "event-bus" });

/**
 * THE LIVE FAN-OUT SEAM (plans/hosted-agents-v2.md §3.17, invariant 15).
 *
 * Every live delivery of transcript events goes through an `EventBus`'s
 * `publish`/`subscribe` and nowhere else. The implementation is chosen per
 * edition through the provider seam (`../providers/event-bus.ts`): onprem — a
 * single api instance — uses the in-process emitter below; cloud, where api
 * pods multiply behind a load balancer, injects a Redis pub/sub bus so a
 * `publish` on one pod reaches an SSE stream held on another
 * (`../ee/event-bus/redis-event-bus.ts`). Shared code never imports `ee/`, so
 * the Redis bus is injected at boot, never referenced here.
 *
 * **Postgres stays the truth.** This bus is a latency optimization, not a
 * delivery guarantee: a dropped publish costs a reconnect, never an event,
 * because every subscriber resumes from a `seq` and the history endpoint is
 * authoritative. Nothing may be built on the assumption that a publish
 * arrives — which is exactly what lets the cloud bus tolerate a Redis blip.
 */

/** What a live subscriber receives: transcript events already assigned `seq`. */
export interface PublishedEvent {
  seq: number;
  turnId: string;
  /** The event's own discriminant, kept narrow so consumers can switch on it. */
  type: AgentEvent["type"];
  event: AgentEvent;
}

export type EventListener = (events: PublishedEvent[]) => void;

/**
 * A live subscription. `release` unsubscribes (idempotent). `ready` resolves
 * once the subscription is genuinely ACTIVE — instant for the in-process bus,
 * but the Redis bus's SUBSCRIBE acks asynchronously, and a caller that reads a
 * history snapshot must `await ready` first: an event committed and published
 * in the gap between an un-acked SUBSCRIBE and the snapshot would otherwise be
 * in neither the tail nor the history, and lost until a reconnect. Awaiting
 * makes "subscribe before snapshot" a real guarantee on every edition.
 */
export interface Subscription {
  release: () => void;
  ready: Promise<void>;
}

/**
 * The seam every edition implements. Deliberately close to the shape the
 * in-process emitter already had, so the Redis bus is a drop-in and the
 * callers change only where they resolve the bus from (plus awaiting `ready`
 * before a history snapshot).
 */
export interface EventBus {
  /** Deliver to everyone tailing this conversation. MUST never throw — the
   * publisher is on the runner's critical path. */
  publish(conversationId: string, events: PublishedEvent[]): void;
  /** Tail a conversation. See `Subscription`. */
  subscribe(conversationId: string, listener: EventListener): Subscription;
  /** Test seam: listeners tailing a conversation right now (this process). */
  subscriberCount(conversationId: string): number;
  /** Test seam: conversations with any listener (this process) — map-leak guard. */
  trackedConversationCount(): number;
}

/**
 * The in-process emitter — the onprem default, and the local fan-out half the
 * Redis bus reuses. A plain `Map<conversationId, Set<listener>>`: correct and
 * zero-latency while one process owns every subscriber.
 */
export const createInProcessEventBus = (): EventBus => {
  const listeners = new Map<string, Set<EventListener>>();

  return {
    publish(conversationId, events) {
      if (events.length === 0) return;
      const subscribers = listeners.get(conversationId);
      if (!subscribers) return;
      // Iterate a copy: a listener may unsubscribe (or subscribe) while we run.
      for (const listener of [...subscribers]) {
        try {
          listener(events);
        } catch (err) {
          log.warn({ err, conversationId }, "event listener threw");
        }
      }
    },

    subscribe(conversationId, listener) {
      const subscribers =
        listeners.get(conversationId) ?? new Set<EventListener>();
      subscribers.add(listener);
      listeners.set(conversationId, subscribers);

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const current = listeners.get(conversationId);
        if (!current) return;
        current.delete(listener);
        // Drop the empty set so the map does not grow one entry per
        // conversation ever streamed.
        if (current.size === 0) listeners.delete(conversationId);
      };
      // In-process delivery is active the instant the listener is in the set.
      return { release, ready: Promise.resolve() };
    },

    subscriberCount: (conversationId) =>
      listeners.get(conversationId)?.size ?? 0,

    trackedConversationCount: () => listeners.size,
  };
};
