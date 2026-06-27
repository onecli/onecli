"use client";

import { Inbox } from "lucide-react";
import { ScrollArea } from "@onecli/ui/components/scroll-area";
import { usePendingApprovals } from "@/hooks/use-approvals";
import type { PendingApproval } from "@/lib/api/approvals";
import { ApprovalListItem } from "./approval-list-item";

interface ApprovalsPopoverProps {
  onShowDetails: (approval: PendingApproval) => void;
}

export const ApprovalsPopover = ({ onShowDetails }: ApprovalsPopoverProps) => {
  const { data: approvals = [] } = usePendingApprovals();

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <span className="text-sm font-medium">Pending approvals</span>
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <span className="size-1.5 animate-pulse rounded-full bg-green-500" />
          Live
        </span>
      </div>

      {approvals.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
          <div className="bg-muted flex size-10 items-center justify-center rounded-full">
            <Inbox className="text-muted-foreground size-5" />
          </div>
          <p className="text-sm font-medium">No pending approvals</p>
          <p className="text-muted-foreground text-xs">
            You&apos;re all caught up.
          </p>
        </div>
      ) : (
        <ScrollArea className="max-h-96">
          <div className="divide-y">
            {approvals.map((approval) => (
              <ApprovalListItem
                key={approval.id}
                approval={approval}
                onShowDetails={() => onShowDetails(approval)}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
};
