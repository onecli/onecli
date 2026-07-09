"use client";

import { ChevronRight, Users } from "lucide-react";
import { useConnectionAgents } from "@/hooks/use-connections";

interface ConnectionAgentAccessSummaryProps {
  connectionId: string;
  onManage: () => void;
}

/**
 * Compact, clickable line on a connection card showing which agents can use it.
 * Self-fetching; renders nothing while loading or when the project has no
 * agents (nothing to show or assign).
 */
export const ConnectionAgentAccessSummary = ({
  connectionId,
  onManage,
}: ConnectionAgentAccessSummaryProps) => {
  const { data: agents = [], isPending } = useConnectionAgents(connectionId);

  if (isPending || agents.length === 0) return null;

  const withAccess = agents.filter((a) => a.access !== "none");
  const label =
    withAccess.length === 0
      ? "No access"
      : withAccess.length === agents.length
        ? "All agents"
        : withAccess.map((a) => a.name).join(", ");

  return (
    <button
      type="button"
      onClick={onManage}
      aria-label={`Manage agent access (${label})`}
      className="flex min-w-0 items-center gap-1.5 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
    >
      <Users className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate" title={label}>
        {label}
      </span>
      <ChevronRight className="size-3 shrink-0 opacity-60" aria-hidden="true" />
    </button>
  );
};
