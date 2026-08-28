"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { conversations } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import type { AttachmentMeta, Turn } from "@/lib/api/types";
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
 */
export const useTurns = (conversationId: string) =>
  useQuery({
    queryKey: queryKeys.conversations.turns(conversationId),
    queryFn: () => conversations.turns(conversationId),
    enabled: conversationId.length > 0,
    refetchInterval: (query) =>
      query.state.error
        ? false
        : hasUnsettledTurn(query.state.data)
          ? 2_500
          : false,
    refetchIntervalInBackground: false,
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
      qc.setQueryData<Turn[]>(
        queryKeys.conversations.turns(conversationId),
        (turns) =>
          turns && !turns.some((turn) => turn.id === outcome.turn.id)
            ? [...turns, outcome.turn]
            : turns,
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
