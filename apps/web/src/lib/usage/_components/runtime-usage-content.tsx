"use client";

import { Skeleton } from "@onecli/ui/components/skeleton";
import { useOrgRuntimeUsage } from "@/hooks/use-usage";
import { formatDuration } from "@/lib/format-duration";

/**
 * How long the org's agents' machines were AWAKE this period, per agent,
 * from the runtime ledger. The number that explains a hosted bill: a
 * machine sleeps when nobody is using it, so this is the time somebody
 * (or something the agent left running) actually used. Names come from the
 * page's own agent list; an agent since deleted keeps its time under its id.
 */
export const RuntimeUsageContent = ({
  periodStart,
  agentNames,
}: {
  /** The period's first day as a UTC date (YYYY-MM-DD). */
  periodStart: string;
  /** Agent id to display name; a plain record, as it crosses the server
   * component boundary. */
  agentNames: Readonly<Record<string, string>>;
}) => {
  const { data, isPending } = useOrgRuntimeUsage({ from: periodStart });
  const total = data?.awakeSeconds ?? 0;
  return (
    <div className="rounded-xl border">
      <div className="border-b px-5 py-3">
        <div className="flex items-center">
          <p className="text-foreground flex-1 text-sm font-semibold">
            Awake time by agent
          </p>
          <p className="text-muted-foreground w-28 text-right text-xs">
            This period
          </p>
        </div>
      </div>
      {isPending ? (
        <div className="space-y-3 px-5 py-4">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : !data || data.agents.length === 0 ? (
        <p className="text-muted-foreground px-5 py-4 text-sm">
          No agent machine has been awake this period.
        </p>
      ) : (
        <div className="divide-y">
          {data.agents.map((agent) => (
            <div
              key={agent.agentId}
              className="flex items-center gap-4 px-5 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="text-foreground truncate text-sm font-medium">
                  {agentNames[agent.agentId] ?? "Deleted agent"}
                </p>
              </div>
              <div className="bg-muted h-1.5 w-16 overflow-hidden rounded-full">
                <div
                  className="bg-brand h-full rounded-full"
                  style={{
                    width: `${total > 0 ? (agent.awakeSeconds / total) * 100 : 0}%`,
                  }}
                />
              </div>
              <p className="text-foreground w-28 text-right text-sm font-medium tabular-nums">
                {formatDuration(agent.awakeSeconds)}
              </p>
            </div>
          ))}
          <div className="flex items-center gap-4 px-5 py-3">
            <p className="text-muted-foreground flex-1 text-sm">Total</p>
            <p className="text-foreground w-28 text-right text-sm font-semibold tabular-nums">
              {formatDuration(total)}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
