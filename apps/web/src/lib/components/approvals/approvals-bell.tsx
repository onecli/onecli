"use client";

import { useEffect, useState } from "react";
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
import { hasWorkspaceContext } from "@/lib/navigation";
import {
  usePendingApprovals,
  usePendingChannelApprovals,
} from "@/hooks/use-approvals";
import { useChannelAlerts } from "@/hooks/use-channel-alerts";
import type { PendingApproval } from "@/lib/api/approvals";
import { bellChannelApprovals } from "@/lib/api/channel-approvals";
import { ApprovalsPopover } from "./approvals-popover";
import { ApprovalDetailsDialog } from "./approval-details-dialog";
import { OPEN_APPROVALS_BELL_EVENT } from "./open-approvals-bell";

/**
 * Header notification bell: pending approvals and lost-connection alerts for
 * the active workspace, with a live count and a popover to approve/reject/
 * inspect each held request.
 * Renders nothing outside a workspace context (in single-workspace editions every
 * dashboard page has one). Self-contained — drop it into any header with no
 * props.
 */
export const ApprovalsBell = () => {
  const pathname = usePathname();
  const { data: approvals = [] } = usePendingApprovals();
  const { data: channelApprovals = [] } = usePendingChannelApprovals();
  const { data: alerts = [] } = useChannelAlerts();
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState<PendingApproval | null>(null);

  // A "Waiting for approval" row elsewhere on the page opens this inbox.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_APPROVALS_BELL_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_APPROVALS_BELL_EVENT, onOpen);
  }, []);

  if (!hasWorkspaceContext(pathname)) return null;

  const count =
    alerts.length +
    approvals.length +
    bellChannelApprovals(channelApprovals).length;
  // The badge counts alerts too, so the label must not promise only
  // approvals behind it.
  const label =
    alerts.length > 0 ? "Pending approvals and alerts" : "Pending approvals";

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
                <span className="sr-only">{label}</span>
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
        <PopoverContent align="end" className="w-96 p-0">
          <ApprovalsPopover
            onNavigate={() => setOpen(false)}
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
