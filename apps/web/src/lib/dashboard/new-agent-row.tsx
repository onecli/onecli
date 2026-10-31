"use client";

import { ChevronDown, Plus } from "lucide-react";
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@onecli/ui/components/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import { useAgentCreateFlow } from "@/app/(dashboard)/w/[workspaceId]/agents/_components/use-agent-create-flow";
import { AgentCreateDoorAlternative } from "@/app/(dashboard)/w/[workspaceId]/agents/_components/agent-create-door-alternative";
import { CreateAgentButton } from "@/lib/agents/_components/create-agent-button";
import { isSplitDoor } from "@/lib/agents/create-door";
import type { AgentKind } from "@/lib/api/types";

interface NewAgentRowProps {
  /** The sidebar's own list (`undefined` while loading) — the door reads
   *  each agent's kind, and sharing the read costs no extra request. */
  agents: { kind: AgentKind }[] | undefined;
  agentsPending: boolean;
}

/**
 * The sidebar's "+ New agent" row, under the last agent. It is the same
 * create door the agents page has (`useAgentCreateFlow`): the row is the
 * door's primary (quota-gated on cloud, like the page's button), and where a
 * second path genuinely exists the row's trailing chevron offers it.
 */
export const NewAgentRow = ({ agents, agentsPending }: NewAgentRowProps) => {
  const flow = useAgentCreateFlow(agents, agentsPending);
  const split = isSplitDoor(flow.door);

  return (
    <SidebarMenuItem>
      <CreateAgentButton
        onClick={flow.openPrimary}
        label="New agent"
        renderTrigger={(onClick) => (
          <SidebarMenuButton
            onClick={onClick}
            // Held until the door is known: the row must never open one
            // dialog and then, a beat later, mean another.
            disabled={!flow.ready}
            tooltip="New agent"
            className="text-muted-foreground hover:text-foreground font-normal"
          >
            <Plus aria-hidden />
            <span>New agent</span>
          </SidebarMenuButton>
        )}
      />
      {split && flow.ready && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuAction
              showOnHover
              aria-label="More ways to create an agent"
            >
              <ChevronDown />
            </SidebarMenuAction>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start">
            <AgentCreateDoorAlternative
              door={flow.door}
              onCreateByo={flow.openByo}
              onCreateHosted={flow.openHosted}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {flow.dialogs}
    </SidebarMenuItem>
  );
};
