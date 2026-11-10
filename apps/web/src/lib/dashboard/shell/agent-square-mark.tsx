"use client";

import { cn } from "@onecli/ui/lib/utils";
import { AgentAvatar } from "@/lib/agents/_components/agent-avatar";
import { agentInitials, agentSquareStyle } from "./agent-square";

/**
 * One agent's mark in the rail and sidebar: its photo when it has one,
 * otherwise its initials on a colour of its own (see `agent-square.ts`).
 * Round in the rail, rounded-square in the sidebar header; the consumer
 * picks via `className`.
 */
export const AgentSquare = ({
  agent,
  pending = false,
  className,
}: {
  agent: { name: string; imageUrl?: string | null };
  pending?: boolean;
  className?: string;
}) =>
  agent.imageUrl || pending ? (
    <AgentAvatar
      agent={agent}
      pending={pending}
      className={cn("size-8 border-0", className)}
    />
  ) : (
    <span
      aria-hidden
      data-testid="agent-initials"
      style={agentSquareStyle(agent.name)}
      className={cn(
        "flex size-8 shrink-0 items-center justify-center text-[11px] font-semibold text-white",
        className,
      )}
    >
      {agentInitials(agent.name)}
    </span>
  );
