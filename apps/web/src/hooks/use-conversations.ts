"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { conversations } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import type {
  AttachmentMeta,
  TranscriptPage,
  TurnsPage,
} from "@/lib/api/types";
import { hasUnsettledTurn } from "@/lib/chat/turns";

/**
 * A staged upload riding a send: the server row's metadata plus the local
 * object URL the optimistic bubble previews with (the settled row swaps to
 * the authenticated blob fetch).
 */
export interface OutgoingAttachment extends AttachmentMeta {
  objectUrl?: string;
}

export interface OutgoingMessage {
  message: string;
  attachments?: OutgoingAttachment[];
}

/**
 * Conversation reads and writes, on the house pattern (`use-agents.ts`).
 * No `invalidateGatewayCache()` anywhere: these are audited `/v1` writes, and
 * none of them changes what the gateway would inject or allow.
 */

/**
 * The conversation's turns — user messages, statuses, and the `Turn.error`
 * column, which is the ONLY place some failures land (a restart or the turn
 * ceiling writes it without publishing any transcript event). Polls while
 * anything is UNSETTLED — an active turn or a `joining` follow-up: a
 * follow-up that promotes and then born-fails emits no stream event either,
 * and a poll that stopped at the active turn's close would leave its bubble
 * reading "received" forever. An errored read stops the loop rather than
 * hammering a 404 (the `use-agents.ts` poll guard).
 *
 * Windowed since the lazy-history change: this is the NEWEST window (the
 * server's default, ~50 turns — the industry chat-open size), not the whole
 * thread. Older windows ride `useOlderTurns` below, on their own key.
 */
export const useTurns = (conversationId: string) =>
  useQuery({
    queryKey: queryKeys.conversations.turns(conversationId),
    queryFn: () => conversations.turns(conversationId),
    enabled: conversationId.length > 0,
    refetchInterval: (query) =>
      query.state.error
        ? false
        : hasUnsettledTurn(query.state.data?.turns)
          ? 2_500
          : false,
    refetchIntervalInBackground: false,
  });

/** One older window plus the transcript events that render its agent side. */
export interface HistoryPage extends TurnsPage {
  events: TranscriptPage["events"];
}

/**
 * The scroll-up loader: OLDER windows of the thread, walked newest→oldest
 * through the `before` cursor. Each page also carries its own transcript
 * events, read as the closed range `(…, until]` where `until` is everything
 * below what the caller already holds — so a page arrives WHOLE (rows and
 * answers together) and the reader never sees the answerless flash the
 * initial load used to show.
 *
 * `enabled` waits for the live window's ANCHOR — the caller passes the FIRST
 * window it saw (its oldest row + `oldestSeq`), latched so a sliding live
 * window never re-keys the gallery — AND for `wanted`: an infinite query
 * fetches its first page the moment it is enabled, and that page must cost
 * nothing until the reader actually scrolls toward history (the whole point
 * of lazy loading). History is immutable, hence `staleTime: Infinity` and no
 * refetch — and the key sits OUTSIDE the live `turns` key on purpose, so the
 * send/settle invalidates never sweep pages that cannot change.
 */
export const useOlderTurns = (
  conversationId: string,
  anchor: { oldestTurnId: string; oldestSeq: number | null } | undefined,
  wanted: boolean,
) =>
  useInfiniteQuery({
    queryKey: queryKeys.conversations.turnsHistory(
      conversationId,
      anchor?.oldestTurnId ?? "",
    ),
    enabled: conversationId.length > 0 && anchor !== undefined && wanted,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    initialPageParam: {
      before: anchor?.oldestTurnId ?? "",
      until: (anchor?.oldestSeq ?? 1) - 1,
    },
    queryFn: async ({ pageParam }): Promise<HistoryPage> => {
      const page = await conversations.turns(conversationId, {
        before: pageParam.before,
      });
      const events =
        // `until < 1` means nothing below the held floor exists — the live
        // window's replay already starts at 0 — so the read is skipped.
        // `oldestSeq` null (an event-less older window) reads to the same
        // bound as its newer neighbor, which returns empty — correct, cheap.
        page.turns.length > 0 && pageParam.until >= 1
          ? await conversations.eventRange(conversationId, {
              since: page.oldestSeq !== null ? page.oldestSeq - 1 : undefined,
              until: pageParam.until,
            })
          : { events: [], nextSince: 0, hasMore: false };
      return { ...page, events: events.events };
    },
    getNextPageParam: (
      last,
      _pages,
      lastPageParam,
    ): { before: string; until: number } | undefined =>
      last.hasMore && last.turns.length > 0
        ? {
            before: last.turns[0]!.id,
            // An event-less page (null oldestSeq) carries its own bound
            // FORWARD rather than deriving from null — deriving would
            // collapse the bound to 0 and silently disable event reads for
            // every older page after it.
            until:
              last.oldestSeq !== null
                ? last.oldestSeq - 1
                : lastPageParam.until,
          }
        : undefined,
  });

/**
 * The agent's one direct thread (§3.18), through the idempotent get-or-create
 * door. Modeled as a QUERY, not a mutation: the door is a PUT that always
 * lands on the same row, so "read" is the honest shape — the thread mounts on
 * whatever this returns. `staleTime: Infinity` because the id never changes
 * once materialized; the 404 self-heal invalidates this key to mint a fresh
 * row if the conversation ever vanishes underneath the page.
 */
export const useDirectConversation = (agentId: string | undefined) =>
  useQuery({
    queryKey: queryKeys.conversations.direct(agentId ?? ""),
    queryFn: () => conversations.ensureDirect(agentId ?? ""),
    enabled: agentId !== undefined && agentId.length > 0,
    staleTime: Infinity,
  });

/**
 * Send a message WHATEVER the agent is doing — the mid-run door. A busy
 * conversation accepts the message as a follow-up (it steers into the live
 * turn or runs next) instead of 409ing, so the only refusal left is the
 * follow-up cap, rendered inline like every send error (no toast).
 *
 * Two cache rules, both load-bearing:
 * - `onSuccess` materializes the returned row directly into the turns cache
 *   (deduped by id, never seeding an absent cache): mid-run multi-send is a
 *   first-class flow now, and a second send resets the mutation's variables
 *   — without the eager row, the first message's bubble would VANISH until
 *   the invalidated refetch lands.
 * - The settled-time invalidate targets EXACTLY this conversation's turns
 *   key, never the `conversations` namespace: the direct-thread query is
 *   backed by a PUT (the get-or-create door), and a prefix invalidate would
 *   re-run a write on every message.
 */
export const useSendMessage = (conversationId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ message, attachments }: OutgoingMessage) =>
      conversations.sendMessage(
        conversationId,
        message,
        attachments?.map((attachment) => attachment.id),
      ),
    onSuccess: (outcome, variables) => {
      qc.setQueryData<TurnsPage>(
        queryKeys.conversations.turns(conversationId),
        (page) =>
          page && !page.turns.some((turn) => turn.id === outcome.turn.id)
            ? { ...page, turns: [...page.turns, outcome.turn] }
            : page,
      );
      // Hand the composer's local previews to the blob cache: the SETTLED row
      // carries metadata only, so without this its chips would re-download
      // bytes this browser just uploaded. Ownership transfers with them — the
      // cache revokes each URL when it evicts the entry.
      for (const attachment of variables.attachments ?? []) {
        if (!attachment.objectUrl) continue;
        qc.setQueryData(
          queryKeys.attachments.blob(conversationId, attachment.id),
          attachment.objectUrl,
        );
      }
    },
    onSettled: () => {
      qc.invalidateQueries({
        queryKey: queryKeys.conversations.turns(conversationId),
      });
    },
  });
};

export const useAbortTurn = (conversationId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: conversations.abortTurn,
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: queryKeys.conversations.turns(conversationId),
      });
    },
    onError: (err) => toast.error(err.message || "Failed to stop"),
  });
};
