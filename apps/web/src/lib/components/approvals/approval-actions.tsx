"use client";

import { Check, X } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { cn } from "@onecli/ui/lib/utils";
import { useDecideApproval } from "@/hooks/use-approvals";
import type { ApprovalSimilar } from "@/lib/api/approvals";
import { ApproveSplitButton } from "./approve-split-button";

interface ApprovalActionsProps {
  approvalId: string;
  /** The gateway's "Approve similar" offer, when this request has one. */
  similar?: ApprovalSimilar | null;
  /** The agent's name, for the "Approve similar" explanation. */
  agentName?: string;
  size?: "xs" | "sm" | "default";
  /** Render compact icon-only buttons (for the Activity table's narrow cell). */
  iconOnly?: boolean;
  onResolved?: () => void;
  className?: string;
}

/** Shared Approve / Deny control, wired to the decision mutation. When the
 *  gateway offers "Approve similar", Approve becomes a split button whose
 *  arrow opens it. */
export const ApprovalActions = ({
  approvalId,
  similar,
  agentName,
  size = "sm",
  iconOnly = false,
  onResolved,
  className,
}: ApprovalActionsProps) => {
  const decideMutation = useDecideApproval();
  const pending = decideMutation.isPending;
  const denyLoading = pending && decideMutation.variables?.decision === "deny";
  const approveLoading =
    pending && decideMutation.variables?.decision === "approve";

  const submit = (decision: "approve" | "deny", offer?: ApprovalSimilar) =>
    decideMutation.mutate(
      { id: approvalId, decision, ...(offer && { similar: offer }) },
      { onSuccess: () => onResolved?.() },
    );

  if (iconOnly) {
    return (
      <div className={cn("flex items-center gap-1", className)}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={pending}
              loading={denyLoading}
              onClick={() => submit("deny")}
              className="text-destructive hover:text-destructive"
            >
              {!denyLoading && <X className="size-3.5" />}
              <span className="sr-only">Deny</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Deny</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={pending}
              loading={approveLoading}
              onClick={() => submit("approve")}
              className="text-emerald-600 hover:text-emerald-600 dark:text-emerald-500"
            >
              {!approveLoading && <Check className="size-3.5" />}
              <span className="sr-only">Approve</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Approve</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Button
        variant="outline"
        size={size}
        disabled={pending}
        loading={denyLoading}
        onClick={() => submit("deny")}
        className="text-destructive hover:text-destructive"
      >
        {!denyLoading && <X className="size-3.5" />}
        Deny
      </Button>
      {similar ? (
        <ApproveSplitButton
          similar={similar}
          agentName={agentName}
          size={size}
          disabled={pending}
          loading={approveLoading}
          onApprove={() => submit("approve")}
          onApproveSimilar={() => submit("approve", similar)}
        />
      ) : (
        <Button
          size={size}
          disabled={pending}
          loading={approveLoading}
          onClick={() => submit("approve")}
        >
          {!approveLoading && <Check className="size-3.5" />}
          Approve
        </Button>
      )}
    </div>
  );
};
