"use client";

import { Inbox } from "lucide-react";
import { ScrollArea } from "@onecli/ui/components/scroll-area";
import {
  usePendingApprovals,
  usePendingChannelApprovals,
} from "@/hooks/use-approvals";
import type { PendingApproval } from "@/lib/api/approvals";
import type { PendingChannelApprovalItem } from "@/lib/api/channel-approvals";
import { ApprovalListItem } from "./approval-list-item";
import { ActionApprovalRow } from "./action-approval-row";
import { ReachAskRow } from "./reach-ask-row";

interface ApprovalsPopoverProps {
  onShowDetails: (approval: PendingApproval) => void;
}

/** One row of the merged inbox, tagged by source. */
type BellItem =
  | { kind: "gateway"; sortKey: string; approval: PendingApproval }
  | { kind: "channel"; sortKey: string; item: PendingChannelApprovalItem };

/**
 * The ONE approvals inbox: gateway tool prompts, one-shot action approvals,
 * and reach asks, merged and sorted by age (oldest first — the longest-
 * waiting decision surfaces on top). Every kind decides right here.
 */
export const ApprovalsPopover = ({ onShowDetails }: ApprovalsPopoverProps) => {
  const { data: gateway = [] } = usePendingApprovals();
  const { data: channel = [] } = usePendingChannelApprovals();

  const items: BellItem[] = [
    ...gateway.map(
      (approval): BellItem => ({
        kind: "gateway",
        sortKey: approval.createdAt,
        approval,
      }),
    ),
    ...channel.map(
      (item): BellItem => ({ kind: "channel", sortKey: item.createdAt, item }),
    ),
  ].sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <span className="text-sm font-medium">Pending approvals</span>
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <span className="size-1.5 animate-pulse rounded-full bg-green-500 motion-reduce:animate-none" />
          Live
        </span>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
          <div className="bg-muted flex size-10 items-center justify-center rounded-full">
            <Inbox
              aria-hidden="true"
              className="text-muted-foreground size-5"
            />
          </div>
          <p className="text-sm font-medium">No pending approvals</p>
          <p className="text-muted-foreground text-xs">
            You&apos;re all caught up.
          </p>
        </div>
      ) : (
        <ScrollArea className="max-h-96">
          <div className="divide-y">
            {items.map((entry) =>
              entry.kind === "gateway" ? (
                <ApprovalListItem
                  key={`gw-${entry.approval.id}`}
                  approval={entry.approval}
                  onShowDetails={() => onShowDetails(entry.approval)}
                />
              ) : entry.item.kind === "action" ? (
                <ActionApprovalRow
                  key={`act-${entry.item.id}`}
                  item={entry.item}
                />
              ) : (
                <ReachAskRow key={`reach-${entry.item.id}`} item={entry.item} />
              ),
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
};
