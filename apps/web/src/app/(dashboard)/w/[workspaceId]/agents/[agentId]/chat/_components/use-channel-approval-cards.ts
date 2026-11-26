"use client";

import { usePendingChannelApprovals } from "@/hooks/use-approvals";
import type { PendingChannelApprovalItem } from "@/lib/api/channel-approvals";

/** One inline channel-approval card: the item and its timeline position. */
export interface ChannelApprovalCard {
  item: PendingChannelApprovalItem;
  /** ms epoch of the hold's creation - where it slots in the thread. */
  at: number;
}

/**
 * Whether this agent's chat shows a pending channel approval the bell
 * shows. Everything the bell lists for this agent, except an action
 * anchored in ANOTHER conversation (another person's thread, or a Slack
 * thread, whose own surface carries it):
 * - an action anchored here: raised by a turn in this conversation, or by
 *   a scheduled run, process watch or webhook that reports here (the
 *   listing hands those this conversation);
 * - an action with no conversation (e.g. the receiving side of a
 *   cross-workspace agent message), which the bell used to carry alone;
 * - a reach ask (who may talk to this agent), which belongs to no thread.
 */
export const showsInChat = (
  item: PendingChannelApprovalItem,
  agentId: string,
  conversationId: string,
): boolean => {
  if (item.agentId !== agentId) return false;
  if (item.kind === "reach") return true;
  return item.conversationId === conversationId || item.conversationId === null;
};

/**
 * The chat's inline channel approvals for THIS agent (see `showsInChat`).
 * Rides the bell's channel cache entry (`usePendingChannelApprovals`), so a
 * decision in the bell, in Slack or here clears all three on the next poll.
 * The server fences the listing to the workspace; the filter here only
 * picks this thread's share.
 */
export const useChannelApprovalCards = (
  agentId: string | undefined,
  conversationId: string,
): ChannelApprovalCard[] => {
  const { data: items = [] } = usePendingChannelApprovals();
  if (!agentId) return [];
  return items
    .filter((item) => showsInChat(item, agentId, conversationId))
    .map((item) => ({ item, at: new Date(item.createdAt).getTime() }));
};
