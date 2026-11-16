"use client";

import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { ApprovalsBell } from "@/lib/components/approvals";
import { useAgentsForWorkspace } from "@/hooks/use-agents";
import { isOrgScopedPath, matchAgentPage } from "@/lib/navigation";
import { AgentTopBarControls } from "./agent-top-bar-controls";
import { InviteIcon } from "./invite-icon";
import { SHELL_TOP_BAR } from "./shell-geometry";
import { SlackChip } from "./slack-chip";
import { UpgradeButton } from "./upgrade-button";

/**
 * The top bar: the Slack chip on the left, the agent's controls, Invite,
 * the approvals bell and Upgrade on the right. Docs and Discord live in the
 * rail's account menu. Outside an agent the left side is empty.
 */
export const DashboardTopBar = ({
  workspaceId,
  onOpenMenu,
}: {
  workspaceId: string | undefined;
  /** Opens the rail + sidebar sheet below `md`. */
  onOpenMenu: () => void;
}) => {
  const pathname = usePathname();
  const inAgent = matchAgentPage(pathname);
  const { data: agents } = useAgentsForWorkspace(
    workspaceId ?? "",
    workspaceId !== undefined,
  );
  const agent = inAgent
    ? agents?.find((a) => a.id === inAgent.agentId)
    : undefined;
  // Invite and Upgrade act on an org, and their server reads take it from
  // the URL (the proxy turns `/w/<id>` and `/org/<id>` into the scope
  // headers). An `/account/*` URL names neither, so they wait for the
  // redirect to land rather than fail their reads.
  const orgScoped = isOrgScopedPath(pathname);

  return (
    <header data-slot="dashboard-top-bar" className={SHELL_TOP_BAR}>
      <Button
        variant="ghost"
        size="icon-sm"
        className="-ml-2 md:hidden"
        onClick={onOpenMenu}
      >
        <Menu className="size-4" />
        <span className="sr-only">Toggle Sidebar</span>
      </Button>
      <div className="flex min-w-0 flex-1 items-center">
        {workspaceId && agent && (
          <SlackChip workspaceId={workspaceId} agent={agent} />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {workspaceId && agent && <AgentTopBarControls agent={agent} />}
        {orgScoped && <InviteIcon />}
        <ApprovalsBell />
        {orgScoped && <UpgradeButton />}
      </div>
    </header>
  );
};
