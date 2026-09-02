"use client";

import { usePathname, useRouter } from "next/navigation";
import { Check, ChevronsUpDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import { cn } from "@onecli/ui/lib/utils";
import { useAgents } from "@/hooks/use-agents";
import { agentSectionPath, matchAgentPage } from "@/lib/navigation";
import {
  agentSectionBlocked,
  defaultAgentSection,
} from "@/lib/agents/agent-sections";

/**
 * The agent's own breadcrumb crumb is a dropdown (§3.18): it names the agent
 * the page is about and switches agents while HOLDING the current section —
 * jump from one agent's Chat straight into another's. Switching to an agent
 * that doesn't have the section (a BYO agent, from Chat) lands on that
 * agent's FIRST section rather than on the frame's backstop notice; which
 * sections exist for which kind is the shared section table's answer, not a
 * copy here.
 */
export const AgentCrumb = ({ agentId }: { agentId: string }) => {
  const pathname = usePathname();
  const router = useRouter();
  const { data: agents = [] } = useAgents();
  const current = agents.find((a) => a.id === agentId);

  const section = matchAgentPage(pathname)?.section ?? "";

  // Hold the section across the switch — unless there is nothing to hold. An
  // empty section means we are standing ON an index, and carrying "" across
  // would land on another index: a page that only redirects, i.e. a blank
  // pane for as long as that takes. Switching agents should land somewhere
  // real, exactly like the blocked-section case beside it.
  const hrefFor = (agent: { id: string; kind: string }) =>
    section === "" || agentSectionBlocked(section, agent.kind)
      ? agentSectionPath(pathname, agent.id, defaultAgentSection(agent.kind))
      : agentSectionPath(pathname, agent.id, section);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex min-w-0 items-center gap-1 rounded-sm text-sm transition-colors outline-none focus-visible:ring-2"
        aria-label={`Agent: ${current?.name ?? "unknown"}. Switch agent`}
      >
        <span className="min-w-0 truncate">{current?.name ?? "Agent"}</span>
        <ChevronsUpDown className="size-3 shrink-0" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {agents.map((agent) => (
          <DropdownMenuItem
            key={agent.id}
            onSelect={() => {
              if (agent.id !== agentId) router.push(hrefFor(agent));
            }}
          >
            <span className="min-w-0 truncate">{agent.name}</span>
            <Check
              className={cn(
                "ml-auto size-4",
                agent.id === agentId ? "opacity-100" : "opacity-0",
              )}
              aria-hidden
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
