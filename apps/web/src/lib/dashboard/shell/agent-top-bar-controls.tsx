"use client";

import { Suspense, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import { useHasDesktop } from "@/hooks/use-has-desktop";
import { withWorkspacePrefix } from "@/lib/navigation";
import { useAgentActivityPaths } from "@/lib/dashboard/use-agent-activity-paths";
import { AgentActionsMenu } from "@/app/(dashboard)/w/[workspaceId]/agents/_components/agent-actions-menu";
import { AgentDetailsDialog } from "@/app/(dashboard)/w/[workspaceId]/agents/[agentId]/_components/agent-details-dialog";
import type { AgentPageAgent } from "@/app/(dashboard)/w/[workspaceId]/agents/[agentId]/_components/agent-page-frame";

// The hosted agent's Computer button. Lazy, so its code never enters a
// self-host's static graph; rendered only where the deployment shows it.
const DesktopHeaderChip = dynamic(() =>
  import("@/ee/desktop/desktop-header-chip").then((m) => m.DesktopHeaderChip),
);

/**
 * What the old agent page header carried besides the name, kept on the new
 * shell in the top bar: the Computer chip and the agent's menu (Details,
 * activity, rename, restart, delete).
 */
export const AgentTopBarControls = ({ agent }: { agent: AgentPageAgent }) => {
  const pathname = usePathname();
  const router = useRouter();
  const activityPaths = useAgentActivityPaths();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const hasDesktop = useHasDesktop() && agent.kind === "hosted";

  return (
    <>
      {hasDesktop && (
        <Suspense fallback={null}>
          <DesktopHeaderChip agentId={agent.id} agentName={agent.name} />
        </Suspense>
      )}
      <AgentActionsMenu
        agent={agent}
        onDetails={() => setDetailsOpen(true)}
        onViewActivity={() => router.push(activityPaths.activity(agent.id))}
        onDeleted={() => router.replace(withWorkspacePrefix(pathname, ""))}
      />
      <AgentDetailsDialog
        agent={agent}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
      />
    </>
  );
};
