"use client";

import { Skeleton } from "@onecli/ui/components/skeleton";
import { useAgentRuntimeUsage } from "@/hooks/use-usage";
import { thisMonthFrom } from "@/lib/api/usage";
import { formatDuration } from "@/lib/format-duration";

/**
 * How long this agent's machine has been awake: this month and all time,
 * from the runtime ledger. A hosted agent's machine sleeps when nobody is
 * using it, so this is the number that explains a bill, and the one the
 * free tier will meter. Two small reads, only while the dialog is open.
 */
export const AgentRuntimeRow = ({ agentId }: { agentId: string }) => {
  const month = useAgentRuntimeUsage(agentId, { from: thisMonthFrom() });
  const allTime = useAgentRuntimeUsage(agentId);
  if (month.isPending || allTime.isPending) {
    return <Skeleton className="ml-auto h-4 w-40" />;
  }
  if (!month.data || !allTime.data) {
    return <span className="text-muted-foreground">Unavailable</span>;
  }
  return (
    <span className="tabular-nums">
      {formatDuration(month.data.awakeSeconds)}
      <span className="text-muted-foreground"> this month</span>
      <span className="text-muted-foreground"> / </span>
      {formatDuration(allTime.data.awakeSeconds)}
      <span className="text-muted-foreground"> all time</span>
    </span>
  );
};
