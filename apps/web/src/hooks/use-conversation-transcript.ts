"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/api/keys";
import { foldTranscript, mergeEvents } from "@/lib/chat/transcript";
import { isActiveTurn, mergeTurnRows } from "@/lib/chat/turns";
import { useOlderTurns, useTurns } from "@/hooks/use-conversations";
import { useConversationStream } from "@/hooks/use-conversation-stream";

/**
 * The READ half of a conversation thread: the live turns window, the
 * bounded-replay stream, the on-demand history gallery, and the fold that
 * gives `ChatThread` its rows and agent-side transcript. Extracted from the
 * direct thread (PR 5b) so a second reader - the agent-to-agent pair
 * conversation dialog - shows the same transcript through the same seams
 * rather than a hand-copied subset. Sending, aborting and the model-key
 * door stay with the direct thread: they are the WRITE half.
 *
 * `conversationId` undefined = nothing to read yet; every query stays
 * disabled and the stream waits.
 */
export const useConversationTranscript = (
  conversationId: string | undefined,
) => {
  const qc = useQueryClient();
  const turnsQuery = useTurns(conversationId ?? "");

  // The live window's ANCHOR: its oldest row + replay floor, latched from the
  // FIRST window this mount saw and pinned for the conversation's life here.
  // Two consumers ride it: the stream's bounded replay (connect from
  // `oldestSeq - 1`, so the server replays the window on screen instead of
  // the whole history) and the scroll-up loader (pages chain down from the
  // anchor row). Latched deliberately — the live window slides as messages
  // land, and a sliding floor must neither tear the stream down nor re-key
  // the history gallery. Set-during-render (the React "adjust state when a
  // prop changes" pattern): the re-render commits before any effect runs, so
  // the stream never connects on a half-latched value.
  const [latchedAnchor, setLatchedAnchor] = useState<{
    conversationId: string;
    oldestTurnId: string;
    oldestSeq: number | null;
  } | null>(null);
  const liveWindow = turnsQuery.data;
  if (
    conversationId !== undefined &&
    liveWindow !== undefined &&
    latchedAnchor?.conversationId !== conversationId
  ) {
    setLatchedAnchor({
      conversationId,
      oldestTurnId: liveWindow.turns[0]?.id ?? "",
      oldestSeq: liveWindow.oldestSeq,
    });
  }
  const anchor =
    latchedAnchor?.conversationId === conversationId ? latchedAnchor : null;

  // History is fetched only on DEMAND: the infinite query would fetch its
  // first page the moment it is enabled, so it stays disabled until the
  // sentinel first fires — a reader who never scrolls up pays nothing.
  // Reset per conversation (the 404 self-heal mints a fresh thread).
  const [historyWanted, setHistoryWanted] = useState(false);
  useEffect(() => {
    setHistoryWanted(false);
  }, [conversationId]);

  const older = useOlderTurns(
    conversationId ?? "",
    // No older pages to chain when the window came back empty of rows.
    anchor !== null && anchor.oldestTurnId !== ""
      ? { oldestTurnId: anchor.oldestTurnId, oldestSeq: anchor.oldestSeq }
      : undefined,
    historyWanted,
  );

  const stream = useConversationStream(conversationId, {
    // Turns only: the invalidate must NOT reach the direct-conversation key,
    // whose query is a PUT — a namespace-wide invalidate would re-run the
    // door (a write) several times per message.
    onTurnBoundary: () => {
      if (conversationId === undefined) return;
      qc.invalidateQueries({
        queryKey: queryKeys.conversations.turns(conversationId),
      });
    },
    // The bounded-replay floor. `undefined` until the first window lands (the
    // stream WAITS — connecting bare would replay the whole history, the
    // exact cost this kills); an empty window (or no events) floors at 0.
    replayFloor:
      anchor === null
        ? undefined
        : anchor.oldestSeq !== null
          ? Math.max(0, anchor.oldestSeq - 1)
          : 0,
  });

  // Older pages' events fold WITH the stream's: history pages carry the
  // durable events for their windows, the stream carries everything from the
  // replay floor up. Seq-keyed dedupe makes the seam idempotent.
  const olderPages = older.data?.pages;
  const folded = useMemo(() => {
    const historyEvents = (olderPages ?? []).flatMap((page) => page.events);
    const all = mergeEvents(
      [...historyEvents].sort((a, b) => a.seq - b.seq),
      stream.events,
    );
    return new Map(foldTranscript(all).map((turn) => [turn.turnId, turn]));
  }, [olderPages, stream.events]);

  // The rows: older pages under the live window, stitched by id (the seam
  // turn appears in neither twice, and a row a sliding live window dropped
  // stays because its page holds it).
  const liveTurns = liveWindow?.turns;
  const turns = useMemo(
    () =>
      mergeTurnRows(
        (olderPages ?? []).flatMap((page) => page.turns),
        liveTurns ?? [],
      ),
    [olderPages, liveTurns],
  );

  // The belt for a turn the stream knows about but the turns list does not:
  // a platform-created row (a watch/cron delivery) can land while the poll
  // is off, and ChatThread renders ROWS — a streamed turnId with no row shows
  // nothing. One invalidate per unseen id, guarded by a ref so a slow refetch
  // cannot loop; reset when the conversation changes.
  const chasedTurnIdsRef = useRef(new Set<string>());
  useEffect(() => {
    chasedTurnIdsRef.current = new Set();
  }, [conversationId]);
  useEffect(() => {
    if (conversationId === undefined) return;
    const known = new Set(turns.map((turn) => turn.id));
    // Only ids the LIVE stream saw can be chased into the live window; an
    // old id folded from a history page is already as present as it gets.
    const unseen = [...folded.keys()].filter(
      (id) => !known.has(id) && !chasedTurnIdsRef.current.has(id),
    );
    if (unseen.length === 0) return;
    for (const id of unseen) chasedTurnIdsRef.current.add(id);
    qc.invalidateQueries({
      queryKey: queryKeys.conversations.turns(conversationId),
    });
  }, [conversationId, folded, turns, qc]);

  // The reveal watchdog (see `loading` below): armed once the conversation
  // is known, fires after 5s so a stream that cannot deliver its caught-up
  // frame (a buffering proxy) can never strand the skeleton.
  const [revealFallback, setRevealFallback] = useState(false);
  useEffect(() => {
    setRevealFallback(false);
    if (conversationId === undefined) return;
    const timer = setTimeout(() => setRevealFallback(true), 5_000);
    return () => clearTimeout(timer);
  }, [conversationId]);

  // ONE reveal, whole: skeleton until the live window has landed AND the
  // stream's bounded replay finished (`caughtUp`) — the cure for "user rows
  // first, answers popping in seconds later". Escapes so the skeleton can
  // never strand: an empty thread has nothing to catch up to; a stream error
  // renders its own frame (the reader's); and a watchdog reveals after 5s
  // regardless (a buffering middlebox proxy can delay SSE forever — showing
  // rows then is strictly better than skeleton forever, and never worse
  // than the old behavior).
  //
  // A thread with nothing SETTLED escapes too, and that one is not a
  // safety valve but the point. What the gate buys is a whole RECORD
  // instead of a torn one — and a turn still in flight has no record yet.
  // Holding the skeleton over it hides the very thing worth watching: the
  // agent's greeting (or any turn opened from elsewhere) runs to completion
  // behind the spinner and lands already finished, which reads as "it
  // replied before I got here". Nothing settled = nothing to tear, so show
  // the live turn and let it write.
  const nothingSettled =
    turns.length > 0 && turns.every((turn) => isActiveTurn(turn));
  const loading =
    turnsQuery.isPending ||
    (!stream.caughtUp &&
      !revealFallback &&
      turns.length > 0 &&
      !nothingSettled &&
      (stream.status === "connecting" ||
        stream.status === "idle" ||
        stream.status === "streaming"));

  return {
    turnsQuery,
    turns,
    folded,
    stream,
    loading,
    // The scroll-up loader: older windows exist while the live window said
    // hasMore or the gallery's last page did.
    hasOlder:
      older.hasNextPage ||
      (liveWindow?.hasMore === true && older.data === undefined),
    loadingOlder: older.isFetching,
    loadOlder: () => {
      // First fire arms the gallery (enabling fetches page one); later fires
      // walk further back.
      if (!historyWanted) setHistoryWanted(true);
      else if (older.hasNextPage && !older.isFetching) {
        void older.fetchNextPage();
      }
    },
  };
};
