"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FlaskConical } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import type { EvalSchedule } from "@/lib/api";
import {
  describeSchedule,
  describeScheduleState,
} from "@/lib/agents/eval-schedule";
import { agentSectionPath } from "@/lib/navigation";

/**
 * The agent's eval schedule, listed with its other schedules so everything
 * the agent does on its own shows in one place. It is managed on the Evals
 * page (its own dialog, results and run history), so the row links there
 * instead of carrying the cron row's controls.
 */
export const EvalScheduleRow = ({
  agentId,
  schedule,
}: {
  agentId: string;
  schedule: EvalSchedule;
}) => {
  const pathname = usePathname();
  const { status, alert, last } = describeScheduleState(schedule);
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <FlaskConical
            className="text-muted-foreground size-3.5 shrink-0"
            aria-hidden
          />
          <span className="truncate text-sm font-medium">Run evals</span>
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
            Evals
          </Badge>
        </div>
        <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 text-xs">
          <span>{describeSchedule(schedule.schedule)}</span>
          <span>{schedule.timezone}</span>
          <span className={cn(alert && "text-destructive")}>{status}</span>
          {last && <span className="truncate">{last}</span>}
        </div>
      </div>
      <Button asChild variant="ghost" size="xs" className="shrink-0">
        <Link href={agentSectionPath(pathname, agentId, "evals")}>
          Manage in Evals
        </Link>
      </Button>
    </div>
  );
};
