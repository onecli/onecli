"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-fetch";
import {
  runConversationStream,
  type StreamFatalError,
  type StreamStatus,
} from "@/lib/chat/conversation-stream";
import { highestSeq, mergeEvents } from "@/lib/chat/transcript";
import type { TurnEvent } from "@/lib/api/types";

const NO_EVENTS: TurnEvent[] = [];

export interface ConversationStream {
  /** Seq-ordered, replay-deduped. Feed to `foldTranscript` downstream. */
  events: TurnEvent[];
  status: StreamStatus;
  /** Set iff `status === "error"`: why the stream stopped for good. */
  error?: StreamFatalError;
  /**
   * True once this conversation's server replay finished (the `caught-up`
   * frame) — the transcript on hand is WHOLE back to the replay floor.
   * Latched per conversation: reconnects re-fire the frame, the reveal
   * decision only needs the first.
   */
  caughtUp: boolean;
}

/**
 * The live transcript of one conversation. A thin shell over the pure engine
 * (`lib/chat/conversation-stream.ts`) — every decision lives there, tested;
 * this file only owns React state and lifecycle.
 *
 * The stream is the single transcript source: connecting without a cursor
 * replays the whole durable history before tailing, so there is no separate
 * REST fetch to race against.
 */
export const useConversationStream = (
  conversationId: string | undefined,
  options: {
    /**
     * Fires once per network read that carried a turn-boundary event —
     * `turn.started` | `turn.done` | `error` — batched, never per event, so
     * a mount replay of N turns costs one call, not N invalidation sweeps.
     * `turn.started` is what makes a turn opened elsewhere (another tab;
     * later Slack/cron) appear while it runs instead of when it ends. The
     * turns poll owns the no-event failure gap; this callback makes the
     * happy path snappy.
     */
    onTurnBoundary?: () => void;
    /**
     * The lowest seq the first connect must replay FROM (exclusive) — the
     * turns window's `oldestSeq - 1`, so the server replays only the turns
     * on screen instead of the whole history. `undefined` = not known yet:
     * the hook WAITS rather than connecting bare, because a bare connect is
     * precisely the full-history replay this exists to avoid. Pass 0 for
     * "replay everything" (an empty window, or no floor to honor).
     *
     * Read at connect time through a ref, deliberately NOT an effect dep: the
     * live window's floor slides as new turns land, and a moving floor must
     * not tear down a healthy connection. Only the first known value gates.
     */
    replayFloor?: number;
  } = {},
): ConversationStream => {
  const [events, setEvents] = useState<TurnEvent[]>(NO_EVENTS);
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [error, setError] = useState<StreamFatalError | undefined>(undefined);
  const [caughtUp, setCaughtUp] = useState(false);

  // The authoritative accumulation. A ref, not state, because the engine's
  // getCursor must read it synchronously between renders.
  const heldRef = useRef<TurnEvent[]>(NO_EVENTS);

  // The connect-time floor (see `replayFloor`). A ref written in an effect
  // (never at render), so later slides never re-run the connect effect; the
  // boolean below is what gates the first connect — and by the time that
  // effect runs, this one (registered first) has already stored the value.
  const replayFloorRef = useRef(options.replayFloor);
  const optionsReplayFloor = options.replayFloor;
  useEffect(() => {
    replayFloorRef.current = optionsReplayFloor;
  }, [optionsReplayFloor]);
  const floorKnown = optionsReplayFloor !== undefined;

  // Effect Events: called from the engine's async continuations, always see
  // the latest props, and are NOT effect deps — a parent re-rendering with a
  // new inline onTurnBoundary must not tear the connection down.
  const handleEvents = useEffectEvent((incoming: TurnEvent[]) => {
    heldRef.current = mergeEvents(heldRef.current, incoming);
    setEvents(heldRef.current); // one setState per network read
    if (
      incoming.some(
        (e) =>
          e.type === "turn.started" ||
          e.type === "turn.done" ||
          e.type === "error",
      )
    ) {
      options.onTurnBoundary?.();
    }
  });

  const handleStatus = useEffectEvent(
    (next: StreamStatus, fatal?: StreamFatalError) => {
      setStatus(next);
      setError(fatal);
    },
  );

  const handleCaughtUp = useEffectEvent(() => setCaughtUp(true));

  useEffect(() => {
    if (!conversationId || !floorKnown) {
      setStatus("idle");
      // A stale latch from the previous conversation (the 404 self-heal
      // minting a fresh thread) must not leak a caught-up signal into the
      // next one's loading gate.
      setCaughtUp(false);
      return;
    }

    // Reset BEFORE connecting: switching conversations must not show the old
    // transcript under the new header, and getCursor must answer 0 so the
    // server replays the new conversation's whole history.
    heldRef.current = NO_EVENTS;
    setEvents(NO_EVENTS);
    setError(undefined);
    setCaughtUp(false);

    const controller = new AbortController();
    void runConversationStream(
      conversationId,
      {
        fetchStream: (path, signal) => apiFetch(path, { signal }),
        // The floor until the replay overtakes it; a reconnect then resumes
        // from the highest seq actually held, exactly as before.
        getCursor: () =>
          Math.max(replayFloorRef.current ?? 0, highestSeq(heldRef.current)),
      },
      {
        onEvents: handleEvents,
        onStatus: handleStatus,
        onCaughtUp: handleCaughtUp,
      },
      controller.signal,
    );

    return () => controller.abort();
  }, [conversationId, floorKnown]);

  return { events, status, error, caughtUp };
};
