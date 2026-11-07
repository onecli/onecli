"use client";

import { Check, ChevronDown, CheckCheck } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import { cn } from "@onecli/ui/lib/utils";
import type { ApprovalSimilar } from "@/lib/api/approvals";

export interface ApproveSplitButtonProps {
  similar: ApprovalSimilar;
  /** The agent's name, for what "similar" lets through. */
  agentName?: string;
  size: "xs" | "sm" | "default";
  disabled: boolean;
  /** Spinner on Approve while either kind of approve is in flight. */
  loading: boolean;
  onApprove: () => void;
  onApproveSimilar: () => void;
}

const TRIGGER_SIZE = { xs: "icon-xs", sm: "icon-sm", default: "icon" } as const;

/**
 * Approve, with an arrow beside it that offers "Approve similar": this
 * request and the agent's next updates of the same kind, bounded by the
 * gateway's window. One control, as narrow as a plain Approve plus an
 * arrow, so it fits the bell's row and a phone's dialog footer.
 */
export const ApproveSplitButton = ({
  similar,
  agentName,
  size,
  disabled,
  loading,
  onApprove,
  onApproveSimilar,
}: ApproveSplitButtonProps) => (
  <div role="group" aria-label="Approve" className="flex items-center">
    <Button
      size={size}
      disabled={disabled}
      loading={loading}
      onClick={onApprove}
      className="rounded-e-none"
    >
      {!loading && <Check className="size-3.5" />}
      Approve
    </Button>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size={TRIGGER_SIZE[size]}
          disabled={disabled}
          aria-label="More ways to approve"
          className={cn(
            "border-primary-foreground/20 rounded-s-none border-s",
            size === "xs" ? "w-5" : "w-7",
          )}
        >
          <ChevronDown className="size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem
          onSelect={onApproveSimilar}
          className="items-start gap-2"
        >
          <CheckCheck className="mt-0.5 size-4" aria-hidden />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">
              Approve similar · {similar.windowMinutes} min
            </span>
            <span className="text-muted-foreground text-xs">
              Also allows up to {similar.maxRequests} more {similar.label} from{" "}
              {agentName ?? "this agent"}.
            </span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
);
