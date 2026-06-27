"use client";

import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import type { PendingApproval } from "@/lib/api/approvals";
import { ApprovalSummaryView } from "./approval-summary-view";
import { ApprovalActions } from "./approval-actions";
import { useCountdown, formatCountdown } from "./use-countdown";

interface ApprovalDetailsContentProps {
  approval: PendingApproval;
  onResolved: () => void;
}

/** Body of the approval details dialog. Rendered only when an approval is set
 *  so the countdown hook never runs against a missing approval. */
export const ApprovalDetailsContent = ({
  approval,
  onResolved,
}: ApprovalDetailsContentProps) => {
  const remaining = useCountdown(approval.expiresAt);

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {approval.summary?.action ?? "Approve request"}
        </DialogTitle>
        <DialogDescription>
          {approval.agent.name} · {approval.host} · expires in{" "}
          {formatCountdown(remaining)}
        </DialogDescription>
      </DialogHeader>
      <ApprovalSummaryView approval={approval} />
      <DialogFooter>
        <ApprovalActions approvalId={approval.id} onResolved={onResolved} />
      </DialogFooter>
    </>
  );
};
