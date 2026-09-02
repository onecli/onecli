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
  } = {},
): ConversationStream => {
  const [events, setEvents] = useState<TurnEvent[]>(NO_EVENTS);
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [error, setError] = useState<StreamFatalError | undefined>(undefined);

  // The authoritative accumulation. A ref, not state, because the engine's
  // getCursor must read it synchronously between renders.
  const heldRef = useRef<TurnEvent[]>(NO_EVENTS);

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

  useEffect(() => {
    if (!conversationId) {
      setStatus("idle");
      return;
    }

    // Reset BEFORE connecting: switching conversations must not show the old
    // transcript under the new header, and getCursor must answer 0 so the
    // server replays the new conversation's whole history.
    heldRef.current = NO_EVENTS;
    setEvents(NO_EVENTS);
    setError(undefined);

    const controller = new AbortController();
    void runConversationStream(
      conversationId,
      {
        fetchStream: (path, signal) => apiFetch(path, { signal }),
        getCursor: () => highestSeq(heldRef.current),
      },
      { onEvents: handleEvents, onStatus: handleStatus },
      controller.signal,
    );

    return () => controller.abort();
  }, [conversationId]);

  return { events, status, error };
};
