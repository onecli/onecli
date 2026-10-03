"use client";

import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import type { PendingApproval } from "@/lib/api/approvals";
import { ApprovalActions } from "./approval-actions";
import { ApprovalAppIcon } from "./approval-app-icon";
import { ApprovalLink } from "./approval-link";
import { rowsBesideTitle } from "./approval-rows";
import { ApprovalTitle } from "./approval-title";
import { useCountdown, formatCountdown } from "./use-countdown";

/** Fields the bell previews; the rest are one click away in Details. */
const PREVIEW_FIELDS = 2;

interface ApprovalListItemProps {
  approval: PendingApproval;
  onShowDetails: () => void;
}

/**
 * One held request in the bell inbox, a compact version of the chat card:
 * the app's logo, the action, who asked, the first couple of fields, and the
 * decision. The bell lists every agent's approvals, so each row stays short.
 */
export const ApprovalListItem = ({
  approval,
  onShowDetails,
}: ApprovalListItemProps) => {
  const remaining = useCountdown(approval.expiresAt);
  const urgent = remaining <= 30;
  const details = rowsBesideTitle(approval.summary);
  const preview = details.slice(0, PREVIEW_FIELDS);
  const more = details.length - preview.length;

  return (
    <div className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex items-center gap-2">
        <ApprovalAppIcon appId={approval.app} />
        <p className="min-w-0 truncate text-sm font-semibold">
          <span className="sr-only">Approval needed: </span>
          <ApprovalTitle
            summary={approval.summary}
            fallback={`${approval.method} request`}
          />
        </p>
        <span
          className={cn(
            "text-muted-foreground ms-auto shrink-0 text-xs tabular-nums",
            // Urgency needs a non-color cue too (WCAG 1.4.1).
            urgent && "font-medium text-amber-600 dark:text-amber-500",
          )}
        >
          {formatCountdown(remaining)}
        </span>
      </div>

      <p className="text-muted-foreground truncate text-xs">
        {approval.agent.name}
        {preview.map((d, i) => (
          <span key={`${d.label}-${i}`}>
            {" · "}
            <ApprovalLink href={d.url}>{d.value}</ApprovalLink>
          </span>
        ))}
        {more > 0 && ` · +${more} more`}
      </p>

      <div className="mt-1 flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="xs"
          onClick={onShowDetails}
          className="text-muted-foreground hover:text-foreground -ms-2"
        >
          Details
        </Button>
        <ApprovalActions approvalId={approval.id} size="xs" />
      </div>
    </div>
  );
};
