"use client";

import { useState } from "react";
import { Button } from "@onecli/ui/components/button";
import { Message, MessageContent } from "@onecli/ui/components/message";
import { cn } from "@onecli/ui/lib/utils";
import type { PendingApproval, SettledOutcome } from "@/lib/api/approvals";
import { ApprovalActions } from "@/lib/components/approvals/approval-actions";
import { ApprovalAppIcon } from "@/lib/components/approvals/approval-app-icon";
import { ApprovalDetailsDialog } from "@/lib/components/approvals/approval-details-dialog";
import { ApprovalPreview } from "@/lib/components/approvals/approval-preview";
import { rowsBesideTitle } from "@/lib/components/approvals/approval-rows";
import { ApprovalTitle } from "@/lib/components/approvals/approval-title";
import {
  formatCountdown,
  useCountdown,
} from "@/lib/components/approvals/use-countdown";

/** How much of a long detail value (e.g. an email body) the card shows. */
const DETAIL_CLAMP_CLASS = "line-clamp-4";

/** What the settled record says about how the approval ended. */
const SETTLED_COPY: Record<SettledOutcome, string> = {
  approved: "Approved",
  denied: "Denied",
  decided: "Decided",
  expired: "Expired (no response) · denied",
};

/**
 * One held request as a native chat message — the web twin of the Telegram /
 * Slack approval card: action title, the parsed detail fields (To / Subject /
 * Body for an email), countdown, and the decision pair. Rendered inside the
 * thread through the same `Message` primitive agent turns use, so it reads as
 * part of the conversation the agent is blocked in. No agent name — the
 * thread only ever shows THIS agent's approvals.
 */
export const InlineApprovalItem = ({
  approval,
  settled,
}: {
  approval: PendingApproval;
  /** Present once the approval left the pending set: how it ended. The card
   * stays in the thread as a quiet record instead of vanishing. */
  settled?: SettledOutcome;
}) => {
  const remaining = useCountdown(approval.expiresAt);
  const urgent = remaining <= 30;
  const details = rowsBesideTitle(approval.summary);
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Settled — and ONLY settled — renders the record row. The poll is the
  // authority on liveness (the gateway drops the row within seconds of
  // expiry and the poll records it); a fast client clock hitting 0 first
  // must not hide the Approve/Deny buttons the header bell still offers,
  // so the countdown parks at 0:00 on the actionable card instead.
  if (settled) {
    return (
      <Message align="start">
        <MessageContent>
          <div
            role="status"
            className="bg-muted/50 text-muted-foreground flex w-fit max-w-[80%] items-baseline gap-1 rounded-xl border px-4 py-2 text-sm"
          >
            <span className="min-w-0 truncate font-medium">
              <ApprovalTitle
                summary={approval.summary}
                fallback={`${approval.method} request`}
              />
            </span>
            <span className="shrink-0">· {SETTLED_COPY[settled]}</span>
          </div>
        </MessageContent>
      </Message>
    );
  }

  return (
    <Message align="start">
      <MessageContent>
        <div className="bg-muted/50 w-fit max-w-[80%] overflow-hidden rounded-xl border">
          {/* Header: what the agent wants to do, and how long the offer lasts. */}
          <div className="flex items-center gap-2.5 px-4 pt-3 pb-2">
            <ApprovalAppIcon appId={approval.app} />
            <p className="min-w-0 truncate text-sm font-semibold">
              <span className="sr-only">Approval needed: </span>
              <ApprovalTitle
                summary={approval.summary}
                fallback={`${approval.method} request`}
              />
            </p>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setDetailsOpen(true)}
              className="text-muted-foreground hover:text-foreground -my-1 shrink-0"
            >
              Details
            </Button>
            <span
              className={cn(
                "text-muted-foreground ms-auto shrink-0 text-xs tabular-nums",
                // Urgency needs a non-color cue too (WCAG 1.4.1), so the
                // amber gains weight instead of standing alone.
                urgent && "font-medium text-amber-600 dark:text-amber-500",
              )}
            >
              expires in {formatCountdown(remaining)}
            </span>
          </div>

          {/* The parsed request (To / Subject / Body for an email), minus
              the record the title already names. The endpoint lives in
              Details; a card with no rows left keeps it, since then it is the
              only hint of what the request does. */}
          {details.length > 0 ? (
            <ApprovalPreview
              kind={approval.summary?.kind}
              details={details}
              className="px-4 pb-3"
            />
          ) : (
            <>
              {/* Legacy rows with no structured summary carry only text. */}
              {!approval.summary && approval.bodyPreview && (
                <p
                  className={cn(
                    "px-4 pb-1 text-sm break-words whitespace-pre-wrap",
                    DETAIL_CLAMP_CLASS,
                  )}
                >
                  {approval.bodyPreview}
                </p>
              )}
              <p className="text-muted-foreground min-w-0 truncate px-4 pb-2 text-xs">
                {approval.host}
                {approval.path}
              </p>
            </>
          )}

          <div className="flex items-center gap-2 border-t bg-background/50 px-4 py-2">
            {/* The consequence of walking away — same sentence as the Slack
                card, so every surface teaches the same rule. */}
            <p className="text-muted-foreground min-w-0 truncate text-xs">
              Undecided means denied.
            </p>
            <ApprovalActions
              approvalId={approval.id}
              size="xs"
              className="ms-auto shrink-0"
            />
          </div>
        </div>
        <ApprovalDetailsDialog
          approval={detailsOpen ? approval : null}
          onClose={() => setDetailsOpen(false)}
          // The card above already shows the full readable preview.
          showSummary={false}
        />
      </MessageContent>
    </Message>
  );
};
