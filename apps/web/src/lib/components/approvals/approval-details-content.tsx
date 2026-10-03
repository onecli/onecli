"use client";

import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import type { PendingApproval } from "@/lib/api/approvals";
import { ApprovalActions } from "./approval-actions";
import { ApprovalPreview } from "./approval-preview";
import { ApprovalRawRequest } from "./approval-raw-request";
import { rowsBesideTitle } from "./approval-rows";
import { ApprovalTitle } from "./approval-title";
import { useCountdown, formatCountdown } from "./use-countdown";

interface ApprovalDetailsContentProps {
  approval: PendingApproval;
  onResolved: () => void;
  /** Show the readable preview above the raw request. Off only where the
   *  opener already shows it in full (the chat card); the bell and Activity
   *  show a compact row, so their dialog must carry the fields. */
  showSummary?: boolean;
}

/** Body of the approval details dialog. Rendered only when an approval is set
 *  so the countdown hook never runs against a missing approval. */
export const ApprovalDetailsContent = ({
  approval,
  onResolved,
  showSummary = true,
}: ApprovalDetailsContentProps) => {
  const remaining = useCountdown(approval.expiresAt);
  const details = rowsBesideTitle(approval.summary);

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          <ApprovalTitle
            summary={approval.summary}
            fallback="Approve request"
          />
        </DialogTitle>
        <DialogDescription>
          {approval.agent.name} · {approval.host} · expires in{" "}
          {formatCountdown(remaining)}
        </DialogDescription>
      </DialogHeader>
      {showSummary && details.length > 0 && (
        <ApprovalPreview kind={approval.summary?.kind} details={details} />
      )}
      <ApprovalRawRequest approval={approval} />
      <DialogFooter>
        <ApprovalActions approvalId={approval.id} onResolved={onResolved} />
      </DialogFooter>
    </>
  );
};
