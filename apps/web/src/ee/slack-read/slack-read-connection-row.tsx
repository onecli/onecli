"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Settings2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Switch } from "@onecli/ui/components/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { AppIcon } from "@/lib/components/app-icon";
import { agentSectionPath } from "@/lib/navigation";
import { useSlackReadConnection, useSlackReadGrants } from "./hooks";

export interface SlackReadConnectionRowProps {
  agentId: string;
}

/**
 * The caller's "Connect your Slack" as a line in the agent's Connections
 * list (licensed), shaped like the app rows around it. Renders only once the
 * caller has connected. The switch reads ON and cannot be flipped here: the
 * connection is the caller's own Slack on this agent's app, and turning it
 * off means disconnecting (which also stops every share), so that lives on
 * the Slack page that Manage opens, beside the shares themselves.
 */
export const SlackReadConnectionRow = ({
  agentId,
}: SlackReadConnectionRowProps) => {
  const pathname = usePathname();
  const connection = useSlackReadConnection(agentId);
  const grants = useSlackReadGrants(agentId);
  if (!connection.data?.connected) return null;

  const profile = connection.data.profile;
  const label =
    profile?.email ?? profile?.realName ?? profile?.handle ?? "Your Slack";
  const mine = (grants.data?.grants ?? []).filter((g) => g.mine).length;
  const href = agentSectionPath(pathname, agentId, "channels");

  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg border dark:border-white/10 dark:bg-white/10">
          <AppIcon icon="/icons/slack.svg" name="Slack" size={18} />
        </div>
        <div className="min-w-0">
          <span className="block truncate text-sm font-medium" translate="no">
            {label}
          </span>
          <span className="text-muted-foreground mt-0.5 block truncate text-xs">
            Slack · read only ·{" "}
            {mine === 1 ? "1 conversation shared" : `${mine} shared`}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Button variant="ghost" size="xs" asChild>
          <Link href={href}>
            <Settings2 className="size-3.5" />
            Manage
          </Link>
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* A disabled control swallows pointer events, so the tooltip
                hangs off a focusable wrapper instead. */}
            <span tabIndex={0} className="inline-flex rounded-full">
              <Switch
                size="sm"
                checked
                disabled
                aria-label="Slack read access is on. Manage it on the Slack page."
              />
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-60 text-pretty">
            Always on while your Slack is connected. Choose what it can read, or
            disconnect, under Manage.
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
};
