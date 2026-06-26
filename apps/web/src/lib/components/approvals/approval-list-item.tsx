"use client";

import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import type { PendingApproval } from "@/lib/api/approvals";
import { ApprovalActions } from "./approval-actions";
import { useCountdown, formatCountdown } from "./use-countdown";

interface ApprovalListItemProps {
  approval: PendingApproval;
  onShowDetails: () => void;
}

export const ApprovalListItem = ({
  approval,
  onShowDetails,
}: ApprovalListItemProps) => {
  const remaining = useCountdown(approval.expiresAt);
  const urgent = remaining <= 30;
  const firstDetail = approval.summary?.details?.[0];

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {approval.summary?.action ?? `${approval.method} request`}
          </p>
          <p className="text-muted-foreground truncate text-xs">
            {approval.agent.name} · {approval.host}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 font-mono text-xs tabular-nums",
            urgent
              ? "text-amber-600 dark:text-amber-500"
              : "text-muted-foreground",
          )}
        >
          {formatCountdown(remaining)}
        </span>
      </div>
      {firstDetail && (
        <p className="text-muted-foreground truncate text-xs">
          <span className="font-medium">{firstDetail.label}:</span>{" "}
          {firstDetail.value}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="xs"
          onClick={onShowDetails}
          className="text-muted-foreground hover:text-foreground"
        >
          Details
        </Button>
        <ApprovalActions approvalId={approval.id} size="xs" />
      </div>
    </div>
  );
};
