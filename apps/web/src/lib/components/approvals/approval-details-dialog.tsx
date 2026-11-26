"use client";

import { Dialog, DialogContent } from "@onecli/ui/components/dialog";
import type { PendingApproval } from "@/lib/api/approvals";
import { ApprovalDetailsContent } from "./approval-details-content";

interface ApprovalDetailsDialogProps {
  approval: PendingApproval | null;
  onClose: () => void;
  /** See `ApprovalDetailsContent`: false only when the opener already shows
   *  the full readable preview (the chat card). */
  showSummary?: boolean;
}

/** Dialog showing a held request (readable preview + the raw request) with
 *  Approve/Deny in the footer. Reused by the bell, Activity, and chat card. */
export const ApprovalDetailsDialog = ({
  approval,
  onClose,
  showSummary,
}: ApprovalDetailsDialogProps) => (
  <Dialog
    open={!!approval}
    onOpenChange={(open) => {
      if (!open) onClose();
    }}
  >
    <DialogContent className="max-h-[85vh] overflow-y-auto">
      {approval && (
        <ApprovalDetailsContent
          approval={approval}
          onResolved={onClose}
          showSummary={showSummary}
        />
      )}
    </DialogContent>
  </Dialog>
);
