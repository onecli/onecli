import type { HarnessEvent, SteerInput } from "@onecli/agent-protocol";

/**
 * The LIVE pickup signal: which steered follow-ups the run
 * consumed, and what the agent said back to each, decided AS IT HAPPENS from
 * the daemon's own events instead of from a history read at turn end.
 *
 * A daemon with the `soft_interrupt_ids` capability (jcode ≥ v0.94.0) takes
 * each queued message with an opaque `client_id` and, the moment the model
 * has it, emits `soft_interrupt_injected { client_ids }`: every id delivered
 * in that injection, in queue order. From there the reply rule is the one
 * the turn-end reconcile already applies (`replyAfter`): the agent's FIRST
 * message after the injection, when it said something before doing anything
 * else. A tool call first means no separate reply; the turn's own answer
 * covers the message.
 *
 * Steers injected together share one entry and so one reply; it goes to the
 * LAST of them in send order, exactly as `settleSteers` decides (the bubble
 * a reader sees the reply under, and the message the agent answered with
 * everything before it in view). The others join with no reply of their own.
 *
 * Pure and synchronous: fed the adapter's frames in order, it returns the
 * events to yield NOW: `message.joined` for every steer the moment its
 * injection lands (the join precedes the reply's first delta, so a reader
 * sees the message picked up and then the reply grow under it), and
 * `message.replied` once the reply is complete. The adapter owns the daemon
 * calls.
 */

/** The daemon frames the tracker reads. Named here, in the adapter's own
 * words, so the tracker's tests need no vendor types. */
export type SteerFrame =
  | { kind: "injected"; clientIds: readonly string[] }
  | { kind: "text"; messageId: string | undefined; text: string }
  | { kind: "replace"; messageId: string; text: string }
  | { kind: "text_done"; messageId: string | undefined }
  | { kind: "tool_start" }
  | { kind: "terminal" };

/** What the tracker yields: a join, or a finished reply. */
export type SteerEvent = Extract<
  HarnessEvent,
  { type: "message.joined" | "message.replied" }
>;

/**
 * What one frame meant for the live pickup: the events to yield now, and,
 * for a text frame the open reply absorbed, the follow-up it is the reply
 * to. The adapter tags the delta it is about to yield with `replyTo`, so
 * the reply streams under the follow-up's own id while it is written. A
 * frame that CLOSES a reply (a second message's first delta, a tool call,
 * the terminal) is never part of it, so it carries no `replyTo`.
 */
export interface SteerObservation {
  events: SteerEvent[];
  replyTo?: string;
}

/**
 * An injection the reply is still being read for: the steer that gets the
 * reply, and the message being read (none until the first delta). The
 * steers that landed with it joined already, silently.
 */
interface OpenReply {
  replier: SteerInput;
  messageId: string | undefined;
  text: string;
}

/**
 * Memory guard on one reply's text. The supervisor caps what it stores
 * (`MAX_ANSWER_CHARS`); this only stops a runaway message from growing the
 * tracker's heap in the meantime.
 */
const MAX_REPLY_CHARS = 256_000;

export interface LiveSteerTracker {
  /** A steer the daemon accepted for this turn, in send order. */
  sent(steer: SteerInput): void;
  /** Feed every frame of the turn, in order. Returns what it meant. */
  observe(frame: SteerFrame): SteerObservation;
  /** The steers the daemon never confirmed by the end: reported missed. */
  unconfirmed(): SteerInput[];
}

export const createLiveSteerTracker = (): LiveSteerTracker => {
  /** Sent and not yet confirmed injected, keyed by id (the client_id). */
  const pending = new Map<string, SteerInput>();
  let open: OpenReply | null = null;
  /** A frame that meant nothing for the pickup: shared, never mutated. */
  const NOTHING: SteerObservation = Object.freeze({ events: [] });

  /** Close the open reply: the reply on the replier when the agent said
   * anything, nothing otherwise (it joined at the injection already). */
  const close = (): SteerObservation => {
    if (!open) return NOTHING;
    const { replier, text } = open;
    open = null;
    const reply = text.trim();
    if (reply.length === 0) return NOTHING;
    return {
      events: [{ type: "message.replied", followUpId: replier.id, reply }],
    };
  };

  return {
    sent(steer) {
      pending.set(steer.id, steer);
    },

    observe(frame) {
      switch (frame.kind) {
        case "injected": {
          // Only ids this turn sent: a stale id (a previous turn's leak the
          // start-of-turn cancel missed) or a foreign one names nothing of
          // ours and is ignored. Send order decides the replier: the LAST
          // pending steer among the injected ids.
          const landed = frame.clientIds.flatMap((id) => {
            const steer = pending.get(id);
            if (!steer) return [];
            pending.delete(id);
            return [steer];
          });
          if (landed.length === 0) return NOTHING;
          // An injection that lands while an earlier reply is still open
          // closes it: the earlier steer's reply is whatever was said so far
          // (`replyAfter` reads "another user message" as the end of it).
          // Then every steer that landed joins NOW, the reply to come.
          const closed = close();
          const replier = landed[landed.length - 1] as SteerInput;
          open = {
            replier,
            messageId: undefined,
            text: "",
          };
          return {
            events: [
              ...closed.events,
              ...landed.map((steer) => ({
                type: "message.joined" as const,
                followUpId: steer.id,
              })),
            ],
          };
        }
        case "text": {
          if (!open) return NOTHING;
          if (open.messageId === undefined && open.text.length === 0) {
            // The first words after the injection: this message is the reply.
            open.messageId = frame.messageId;
          } else if (open.messageId !== frame.messageId) {
            // A second message began (an unframed bridge never gets here:
            // without ids every delta reads as one message until a tool or
            // the terminal closes it): the reply is complete, and these
            // words are the turn's own.
            return close();
          }
          const room = MAX_REPLY_CHARS - open.text.length;
          if (room > 0) open.text += frame.text.slice(0, room);
          return { events: [], replyTo: open.replier.id };
        }
        case "replace":
          // A correction of the reply's own message (a provider attempt
          // rolled back and replayed): the replacement IS the reply now, so
          // the abandoned half never reaches the stored answer. Any other
          // message's correction is not the reply's business. Never tagged:
          // a correction has no wire form, so nothing streams from it.
          if (open && open.messageId === frame.messageId) {
            open.text = frame.text.slice(0, MAX_REPLY_CHARS);
          }
          return NOTHING;
        case "text_done":
          // The reply's own close, when the bridge frames it. A `text_done`
          // for some other message (or an unframed one before any delta)
          // says nothing about the reply.
          return open &&
            open.messageId !== undefined &&
            open.messageId === frame.messageId
            ? close()
            : NOTHING;
        case "tool_start":
        case "terminal":
          // The agent went to work (or the run ended): whatever it said
          // since the injection is the reply, possibly nothing.
          return close();
      }
    },

    unconfirmed() {
      return [...pending.values()];
    },
  };
};
