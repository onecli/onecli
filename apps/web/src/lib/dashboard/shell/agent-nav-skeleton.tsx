import { Skeleton } from "@onecli/ui/components/skeleton";
import { cn } from "@onecli/ui/lib/utils";
import { SIDEBAR_AGENT_HEADER, SIDEBAR_ROW } from "./shell-geometry";

/**
 * The sidebar inside an agent while the agent loads: its header (photo and
 * name, on the top bar's line) and its five everyday rows, each the height
 * of the row that replaces it (32px: a real row's height comes from its
 * 20px line of text, which a placeholder does not have), so the sidebar
 * fills in without moving.
 */
export const AgentNavSkeleton = () => (
  <div aria-hidden data-agent-nav-skeleton>
    <div className={SIDEBAR_AGENT_HEADER}>
      <Skeleton className="size-8 shrink-0 rounded-lg" />
      <Skeleton className="h-4 w-28" />
    </div>
    <div className="flex flex-col gap-0.5">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className={cn(SIDEBAR_ROW, "h-8")}>
          <Skeleton className="size-4 shrink-0" />
          <Skeleton className="h-3.5 w-20" />
        </div>
      ))}
    </div>
  </div>
);
