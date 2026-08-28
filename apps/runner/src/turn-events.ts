import {
  isTerminalEvent,
  type AgentEvent,
  type RunnerEvent,
} from "@onecli/agent-protocol";

/**
 * THE DELTA LAW, runner side (plans/hosted-agents-v2.md §3.17).
 *
 * A model emits text a few characters at a time. Forwarding each chunk as its
 * own HTTP round trip would make the control plane's write path scale with
 * typing speed, so this buffers briefly and merges consecutive text into one
 * event before posting.
 *
 * Two properties matter and are both tested:
 *
 * - **Order is never disturbed.** Merging only ever collapses *adjacent*
 *   deltas of the same kind; anything else (a tool call, a terminal event)
 *   ends the run and passes through in place.
 * - **A flush never exceeds the wire's batch caps** — neither the 100-event
 *   count nor the serialized size. The poster does not chunk on its own, so
 *   an oversized flush is rejected wholesale and swallowed as a warning: the
 *   user would lose a stretch of their turn and nothing would say why.
 *
 * Size is the one that bites. An event's strings carry model output — a
 * `tool.finished` holds whatever the agent just read — so a single legitimate
 * event can be megabytes, and it lands in a database column. Text is
 * truncated with a visible marker rather than dropped, because a truncated
 * answer is a bad answer while a missing one is a bug report.
 */

/** The wire's `events: z.array(...).min(1).max(100)`. */
export const MAX_EVENTS_PER_POST = 100;

/**
 * Per-string ceiling. Big enough for any tool output worth reading in a
 * transcript, small enough that 100 of them cannot approach the wire's cap.
 */
export const MAX_EVENT_TEXT_CHARS = 16_000;

/** Target for one post, serialized. Comfortably under the wire's own cap. */
export const MAX_BATCH_CHARS = 256_000;

/** How long text may accumulate before it is sent. Long enough to collapse a
 * burst of tokens, short enough that a reader still sees text "typing". */
export const FLUSH_INTERVAL_MS = 250;

const isTextual = (
  event: AgentEvent,
): event is Extract<AgentEvent, { type: "text.delta" | "thinking.delta" }> =>
  event.type === "text.delta" || event.type === "thinking.delta";

/**
 * Merge runs of adjacent same-kind text into single events. Everything else
 * is preserved exactly, in position.
 */
export const coalesce = (events: AgentEvent[]): AgentEvent[] => {
  const out: AgentEvent[] = [];
  for (const event of events) {
    const previous = out.at(-1);
    if (
      isTextual(event) &&
      previous &&
      isTextual(previous) &&
      previous.type === event.type
    ) {
      out[out.length - 1] = { ...previous, text: previous.text + event.text };
      continue;
    }
    out.push(event);
  }
  return out;
};

/** Split a batch so no post exceeds the wire's cap. */
export const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

/**
 * U+0000. Built rather than written as an escape, so the byte itself never
 * appears in this source file.
 */
const NUL = String.fromCharCode(0);

/**
 * Bound a string and make it storable.
 *
 * The truncation is about size. The NUL strip is about a subtler failure: JSON
 * permits U+0000 and PostgreSQL accepts it in neither `text` nor `jsonb`, so
 * an agent that reads a binary file emits a perfectly valid event the database
 * refuses — taking the whole batch down with it and losing that stretch of the
 * turn. Stripping is right here where rejecting is right for user input: the
 * user did not type this, and a transcript missing a few bytes beats a
 * transcript missing a minute.
 */
const clean = (value: string): string => {
  const withoutNul = value.includes(NUL) ? value.split(NUL).join("") : value;
  return withoutNul.length <= MAX_EVENT_TEXT_CHARS
    ? withoutNul
    : `${withoutNul.slice(0, MAX_EVENT_TEXT_CHARS)}\n… [truncated ${
        withoutNul.length - MAX_EVENT_TEXT_CHARS
      } characters]`;
};

/**
 * Bound every string an event carries. Applied per event kind rather than by
 * walking the object, so adding a field to the vocabulary is a compile error
 * here instead of a silently unbounded one on the wire.
 */
export const clamp = (event: AgentEvent): AgentEvent => {
  switch (event.type) {
    case "text.delta":
    case "thinking.delta":
      return { ...event, text: clean(event.text) };
    // The whole answer, and the ONE text the transcript keeps — so the same
    // bound applies here as to a delta, and a very long reply is stored
    // truncated with a visible marker rather than unbounded. This is the only
    // string in the vocabulary a user reads back later, so silently dropping
    // the tail would be worse than saying it was cut.
    case "text":
      return { ...event, text: clean(event.text) };
    case "tool.started":
      return {
        ...event,
        callId: clean(event.callId),
        name: clean(event.name),
      };
    case "tool.finished":
      return {
        ...event,
        callId: clean(event.callId),
        name: clean(event.name),
        output: clean(event.output),
      };
    case "approval.pending":
      return { ...event, description: clean(event.description) };
    case "notice":
      return { ...event, text: clean(event.text) };
    case "error":
      return {
        ...event,
        message: clean(event.message),
        ...(event.code && { code: clean(event.code) }),
      };
    case "message.joined":
      // A control-plane row id, not sandbox prose — but bounded anyway: the
      // supervisor relays what a harness adapter handed it.
      return { ...event, followUpId: clean(event.followUpId) };
    case "turn.started":
    case "turn.done":
      // No strings to bound; `usage` is numbers.
      return event;
  }
};

/**
 * Split so each post stays under the serialized cap as well as the count cap.
 * Events are already clamped, so no single one can exceed a batch — but a
 * batch of large ones still can.
 */
export const chunkBySize = (
  events: AgentEvent[],
  maxChars: number,
): AgentEvent[][] => {
  const batches: AgentEvent[][] = [];
  let current: AgentEvent[] = [];
  let size = 0;

  for (const event of events) {
    const cost = JSON.stringify(event).length + 1;
    if (current.length > 0 && size + cost > maxChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(event);
    size += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
};

export interface TurnEventCollectorOptions {
  /** Post a batch. Called once per chunk, in order. */
  post: (event: RunnerEvent) => void;
  flushIntervalMs?: number;
  /** Injected in tests so flushing is deterministic rather than timed. */
  scheduler?: {
    set: (fn: () => void, ms: number) => NodeJS.Timeout;
    clear: (handle: NodeJS.Timeout) => void;
  };
}

export interface TurnEventCollector {
  /** Buffer one event from a turn. Terminal events flush immediately. */
  add(
    sandboxId: string,
    conversationId: string,
    turnId: string,
    event: AgentEvent,
  ): void;
  /** Send whatever is buffered for a turn right now. */
  flush(turnId: string): void;
  /** Send everything and stop the timers (shutdown, or a closed sandbox). */
  flushAll(): void;
}

interface Buffered {
  /** The authenticated sandbox this turn's events came from. */
  sandboxId: string;
  conversationId: string;
  events: AgentEvent[];
  timer?: NodeJS.Timeout;
}

export const createTurnEventCollector = ({
  post,
  flushIntervalMs = FLUSH_INTERVAL_MS,
  scheduler = { set: setTimeout, clear: clearTimeout },
}: TurnEventCollectorOptions): TurnEventCollector => {
  const buffers = new Map<string, Buffered>();

  const flush = (turnId: string): void => {
    const buffered = buffers.get(turnId);
    if (!buffered) return;
    if (buffered.timer) scheduler.clear(buffered.timer);
    buffers.delete(turnId);
    if (buffered.events.length === 0) return;

    // Coalesce → clamp each string → split by count → split by size. The last
    // two are separate passes because they bound different things and either
    // alone lets an illegal batch through.
    const prepared = coalesce(buffered.events).map(clamp);
    for (const byCount of chunk(prepared, MAX_EVENTS_PER_POST)) {
      for (const batch of chunkBySize(byCount, MAX_BATCH_CHARS)) {
        post({
          kind: "turn.events",
          sandboxId: buffered.sandboxId,
          conversationId: buffered.conversationId,
          turnId,
          events: batch,
        });
      }
    }
  };

  return {
    add(sandboxId, conversationId, turnId, event) {
      const buffered = buffers.get(turnId) ?? {
        sandboxId,
        conversationId,
        events: [],
      };
      buffered.events.push(event);
      buffers.set(turnId, buffered);

      // A turn's last event must not wait on a timer — the reader is watching
      // for exactly this to know the answer is complete.
      if (isTerminalEvent(event)) {
        flush(turnId);
        return;
      }

      if (!buffered.timer) {
        buffered.timer = scheduler.set(() => flush(turnId), flushIntervalMs);
        // Never hold the process open for buffered text.
        buffered.timer.unref?.();
      }
    },

    flush,

    flushAll() {
      for (const turnId of [...buffers.keys()]) flush(turnId);
    },
  };
};
