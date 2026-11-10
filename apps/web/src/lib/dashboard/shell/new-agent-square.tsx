"use client";

import { Plus } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import { cn } from "@onecli/ui/lib/utils";
import { useAgentsForWorkspace } from "@/hooks/use-agents";
import { useAgentCreateFlow } from "@/app/(dashboard)/w/[workspaceId]/agents/_components/use-agent-create-flow";
import { AgentCreateDoorAlternative } from "@/app/(dashboard)/w/[workspaceId]/agents/_components/agent-create-door-alternative";
import { CreateAgentButton } from "@/lib/agents/_components/create-agent-button";
import { isSplitDoor } from "@/lib/agents/create-door";
import { RailItem } from "./rail-item";
import { NewAgentGlyph } from "./new-agent-glyph";
import { RAIL_BUTTON, RAIL_BUTTON_IDLE } from "./shell-geometry";

/** The "+" square: the workspace's create-agent door.
 *  The quota gate (`CreateAgentButton`) wraps the primary; where the door
 *  has a second path the square opens a small menu naming both. */
export const NewAgentSquare = ({ workspaceId }: { workspaceId: string }) => {
  const { data: agents, isPending } = useAgentsForWorkspace(workspaceId);
  const flow = useAgentCreateFlow(agents, isPending);
  const split = isSplitDoor(flow.door) && flow.ready;
  const glyph = <NewAgentGlyph />;
  return (
    <>
      <CreateAgentButton
        onClick={flow.openPrimary}
        label="New agent"
        renderTrigger={(onClick) =>
          split ? (
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="New agent"
                      className={cn(RAIL_BUTTON, RAIL_BUTTON_IDLE)}
                    >
                      {glyph}
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="right">New agent</TooltipContent>
              </Tooltip>
              <DropdownMenuContent side="right" align="start">
                <DropdownMenuItem onSelect={onClick}>
                  <Plus className="size-3.5" aria-hidden />
                  New agent
                </DropdownMenuItem>
                <AgentCreateDoorAlternative
                  door={flow.door}
                  onCreateByo={flow.openByo}
                  onCreateHosted={flow.openHosted}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <RailItem
              label="New agent"
              onClick={onClick}
              disabled={!flow.ready}
            >
              {glyph}
            </RailItem>
          )
        }
      />
      {flow.dialogs}
    </>
  );
};
