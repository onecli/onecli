"use client";

import { Suspense, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { AgentAvatarEditor } from "@/lib/agents/_components/agent-avatar-editor";
import { Button } from "@onecli/ui/components/button";
import { withWorkspacePrefix } from "@/lib/navigation";
import { useHostedAvailability } from "@/hooks/use-hosted-availability";
import { useHasDesktop } from "@/hooks/use-has-desktop";
import { AgentStatusPill } from "@/lib/agents/_components/agent-status-pill";
import { AgentActionsMenu } from "../../_components/agent-actions-menu";
import { AgentDetailsDialog } from "./agent-details-dialog";
import type { AgentPageAgent } from "./agent-page-frame";

// The hosted agent's Computer button. Lazy, so its code never enters a
// self-host's static graph; rendered only where the deployment shows it.
const DesktopHeaderChip = dynamic(() =>
  import("@/ee/desktop/desktop-header-chip").then((m) => m.DesktopHeaderChip),
);

interface AgentPageHeaderProps {
  agent: AgentPageAgent;
}

/**
 * One compact row: who this page is about, and the door back. Status renders
 * through the one shared pill (§3.18 rule 1 — card, chat, agent page: same
 * component, same vocabulary), and only for hosted agents.
 */
export const AgentPageHeader = ({ agent }: AgentPageHeaderProps) => {
  const pathname = usePathname();
  const router = useRouter();
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Read, not polled: the chat section owns the poll; the shared cache is
  // fresh enough for a header pill.
  const availability = useHostedAvailability();
  const hasDesktop = useHasDesktop() && agent.kind === "hosted";

  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b px-4 sm:px-6">
      <Button
        variant="ghost"
        size="icon-sm"
        asChild
        aria-label="Back to Agents"
      >
        <Link href={withWorkspacePrefix(pathname, "/agents")}>
          <ArrowLeft className="size-4" />
        </Link>
      </Button>
      <AgentAvatarEditor agent={agent} />
      <div className="flex min-w-0 items-center gap-2.5">
        <h1 className="truncate text-base font-semibold tracking-tight">
          {agent.name}
        </h1>
        {agent.kind === "hosted" && (
          <AgentStatusPill
            availability={availability}
            workingInBackground={agent.workingInBackground}
          />
        )}
      </div>
      <div className="ml-auto flex items-center gap-2">
        {hasDesktop && (
          // Its own boundary: while the button's code loads, the header and
          // the section below stay on screen rather than the route's
          // loading state.
          <Suspense fallback={null}>
            <DesktopHeaderChip agentId={agent.id} agentName={agent.name} />
          </Suspense>
        )}
        <AgentActionsMenu
          agent={agent}
          onDetails={() => setDetailsOpen(true)}
          onViewActivity={() =>
            router.push(
              withWorkspacePrefix(
                pathname,
                `/activity?agent=${encodeURIComponent(agent.id)}`,
              ),
            )
          }
          onDeleted={() =>
            router.push(withWorkspacePrefix(pathname, "/agents"))
          }
        />
      </div>

      <AgentDetailsDialog
        agent={agent}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
      />
    </div>
  );
};
