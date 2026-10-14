"use client";

import { usePendingChannelApprovals } from "@/hooks/use-approvals";
import type { PendingActionApprovalItem } from "@/lib/api/channel-approvals";

/** One inline action-approval card: the item and its timeline position. */
export interface ActionApprovalCard {
  item: PendingActionApprovalItem;
  /** ms epoch of the hold's creation - where it slots in the thread. */
  at: number;
}

/**
 * The chat's inline ACTION approvals: pending holds (send_message,
 * message_agent) raised by THIS agent's turn in THIS conversation. Rides
 * the bell's channel cache entry (`usePendingChannelApprovals`), so a
 * decision in the bell, in Slack or here clears all three on the next
 * poll. The server fences the listing to the workspace; the filter here
 * only picks this thread's share.
 */
export const useActionApprovalCards = (
  agentId: string | undefined,
  conversationId: string,
): ActionApprovalCard[] => {
  const { data: items = [] } = usePendingChannelApprovals();
  if (!agentId) return [];
  return items
    .filter(
      (item): item is PendingActionApprovalItem =>
        item.kind === "action" &&
        item.agentId === agentId &&
        item.conversationId === conversationId,
    )
    .map((item) => ({ item, at: new Date(item.createdAt).getTime() }));
};
