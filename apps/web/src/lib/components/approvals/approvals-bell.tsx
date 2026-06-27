"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Bell } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@onecli/ui/components/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { PROJECT_PATH_RE } from "@/lib/navigation";
import { usePendingApprovals } from "@/hooks/use-approvals";
import type { PendingApproval } from "@/lib/api/approvals";
import { ApprovalsPopover } from "./approvals-popover";
import { ApprovalDetailsDialog } from "./approval-details-dialog";

/**
 * Header notification bell showing pending approvals for the active project,
 * with a live count and a popover to approve/reject/inspect each held request.
 * Renders nothing outside a project page. Self-contained — drop it into any
 * header with no props.
 */
export const ApprovalsBell = () => {
  const pathname = usePathname();
  const onProjectPage = PROJECT_PATH_RE.test(pathname);
  const { data: approvals = [] } = usePendingApprovals();
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState<PendingApproval | null>(null);

  if (!onProjectPage) return null;

  const count = approvals.length;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="relative">
                <Bell className="size-4" />
                {count > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center">
                    <span className="bg-destructive/60 absolute inline-flex size-full animate-ping rounded-full opacity-75" />
                    <span className="bg-destructive relative inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold text-white tabular-nums">
                      {count > 9 ? "9+" : count}
                    </span>
                  </span>
                )}
                <span className="sr-only">Pending approvals</span>
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>Pending approvals</TooltipContent>
        </Tooltip>
        <PopoverContent align="end" className="w-96 p-0">
          <ApprovalsPopover
            onShowDetails={(approval) => {
              setOpen(false);
              setDetails(approval);
            }}
          />
        </PopoverContent>
      </Popover>
      <ApprovalDetailsDialog
        approval={details}
        onClose={() => setDetails(null)}
      />
    </>
  );
};
