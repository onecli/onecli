"use client";

import { Dialog, DialogContent } from "@onecli/ui/components/dialog";
import type { PendingApproval } from "@/lib/api/approvals";
import { ApprovalDetailsContent } from "./approval-details-content";

interface ApprovalDetailsDialogProps {
  approval: PendingApproval | null;
  onClose: () => void;
}

/** Dialog showing a held request's full summary with Approve/Reject in the
 *  footer. Reused by the header popover and the Activity screen. */
export const ApprovalDetailsDialog = ({
  approval,
  onClose,
}: ApprovalDetailsDialogProps) => (
  <Dialog
    open={!!approval}
    onOpenChange={(open) => {
      if (!open) onClose();
    }}
  >
    <DialogContent className="max-h-[85vh] overflow-y-auto">
      {approval && (
        <ApprovalDetailsContent approval={approval} onResolved={onClose} />
      )}
    </DialogContent>
  </Dialog>
);
