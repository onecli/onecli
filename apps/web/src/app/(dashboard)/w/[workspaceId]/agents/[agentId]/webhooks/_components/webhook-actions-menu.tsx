"use client";

import Link from "next/link";
import { History, MoreHorizontal, Pencil } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import { useAgentActivityPaths } from "@/lib/dashboard/use-agent-activity-paths";

export interface WebhookActionsMenuProps {
  agentId: string;
  webhookId: string;
  name: string;
  onEdit: () => void;
}

/** A webhook row's "…" menu: open its runs (Activity, narrowed to this one
 * webhook) or edit it. */
export const WebhookActionsMenu = ({
  agentId,
  webhookId,
  name,
  onEdit,
}: WebhookActionsMenuProps) => {
  const activityPaths = useAgentActivityPaths();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={`${name} actions`}>
          <MoreHorizontal className="size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={activityPaths.webhookRuns(agentId, webhookId)}>
            <History className="size-4" aria-hidden />
            View runs
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil className="size-4" aria-hidden />
          Edit
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
