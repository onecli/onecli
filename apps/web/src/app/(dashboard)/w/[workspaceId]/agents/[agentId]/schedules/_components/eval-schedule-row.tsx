"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FlaskConical,
  MoreHorizontal,
  Pencil,
  Play,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import { Switch } from "@onecli/ui/components/switch";
import {
  useDeleteEvalSchedule,
  useSaveEvalSchedule,
  useStartEvalRun,
} from "@/hooks/use-evals";
import { ScheduleDialog } from "../../evals/_components/schedule-dialog";
import { CheckRunButton } from "./check-run-button";
import { RunDot, type RunTone } from "./run-dot";
import {
  SCHEDULE_CELL,
  SCHEDULE_GRID,
  formatWhen,
  nextRunLabel,
} from "./schedule-grid";
import { cn } from "@onecli/ui/lib/utils";
import type { EvalRunSummary, EvalSchedule } from "@/lib/api";
import { isActiveEvalRun } from "@onecli/api/validations/evals";
import {
  describeSchedule,
  describeScheduleState,
} from "@/lib/agents/eval-schedule";
import { agentSectionPath } from "@/lib/navigation";

const RUN_TONE: Record<EvalRunSummary["status"], RunTone> = {
  queued: "running",
  running: "running",
  done: "ok",
  failed: "failed",
};
const RUN_LABEL: Record<EvalRunSummary["status"], string> = {
  queued: "Starting",
  running: "Running",
  done: "Last run finished",
  failed: "Last run failed",
};

/**
 * The agent's eval schedule, listed with its other schedules so everything
 * the agent does on its own shows in one place. It has the same controls as
 * a cron row (Run now, pause switch, menu), all through the Evals page's own
 * hooks and dialog; its results live there, a link away.
 */
export const EvalScheduleRow = ({
  agentId,
  schedule,
  latestRun,
  refetch,
}: {
  agentId: string;
  schedule: EvalSchedule;
  latestRun: EvalRunSummary | null;
  /** Reloads the evals view, for the Running now check. */
  refetch: () => Promise<unknown>;
}) => {
  const pathname = usePathname();
  const remove = useDeleteEvalSchedule(agentId);
  const save = useSaveEvalSchedule(agentId);
  const start = useStartEvalRun(agentId);
  // Keyed per open so the dialog starts from the saved schedule each time.
  const [dialog, setDialog] = useState({ open: false, key: 0 });
  const { status, alert } = describeScheduleState(schedule);
  const running = latestRun !== null && isActiveEvalRun(latestRun.status);
  const evalsPath = agentSectionPath(pathname, agentId, "evals");
  return (
    <div className={cn(SCHEDULE_GRID, "px-4 py-3")}>
      <div className="flex min-w-0 items-center gap-2">
        <FlaskConical
          className="text-muted-foreground size-3.5 shrink-0"
          aria-hidden
        />
        <span className="truncate text-sm font-medium">Run evals</span>
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          Evals
        </Badge>
      </div>
      <span
        title={schedule.timezone}
        className={cn(
          SCHEDULE_CELL,
          "font-medium text-emerald-700 dark:text-emerald-400",
        )}
      >
        {describeSchedule(schedule.schedule)}
      </span>
      {/* Same Next / Last cells as a cron row. Why it paused is a hover
          away; Last follows the newest eval run, however it was started. */}
      <span
        title={status}
        className={cn(
          SCHEDULE_CELL,
          alert ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {nextRunLabel(schedule)}
      </span>
      <span
        className={cn(
          SCHEDULE_CELL,
          "text-muted-foreground md:flex md:items-center md:gap-1.5",
        )}
      >
        {latestRun ? (
          <>
            <Link
              href={evalsPath}
              title={
                running
                  ? `Started ${formatWhen(latestRun.createdAt)}`
                  : RUN_LABEL[latestRun.status]
              }
              className="hover:text-foreground flex min-w-0 items-center gap-1.5 underline-offset-4 hover:underline"
            >
              <RunDot tone={RUN_TONE[latestRun.status]} />
              <span className="truncate">
                {running
                  ? "Running now"
                  : formatWhen(latestRun.finishedAt ?? latestRun.createdAt)}
              </span>
            </Link>
            {running && <CheckRunButton refetch={refetch} />}
          </>
        ) : (
          "Never yet"
        )}
      </span>
      <div className="flex shrink-0 items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="xs"
          disabled={start.isPending || running}
          loading={start.isPending}
          onClick={() =>
            start.mutate(undefined, {
              onSuccess: () => toast.success("Running the evals"),
              onError: (error) => toast.error(error.message),
            })
          }
        >
          <Play className="size-3.5" />
          Run now
        </Button>
        <Switch
          size="sm"
          checked={schedule.enabled}
          disabled={save.isPending}
          aria-label={`${schedule.enabled ? "Pause" : "Resume"} Run evals`}
          onCheckedChange={(enabled) =>
            save.mutate(
              {
                schedule: schedule.schedule,
                timezone: schedule.timezone,
                enabled,
              },
              { onError: (error) => toast.error(error.message) },
            )
          }
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="More for Run evals"
            >
              <MoreHorizontal className="size-3.5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() =>
                setDialog((d) => ({ open: true, key: d.key + 1 }))
              }
            >
              <Pencil className="size-4" aria-hidden />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={evalsPath}>
                <SquareArrowOutUpRight className="size-4" aria-hidden />
                View eval results
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() =>
                remove.mutate(undefined, {
                  onSuccess: () => toast.success("Eval schedule removed"),
                  onError: (error) => toast.error(error.message),
                })
              }
            >
              <Trash2 className="size-4" aria-hidden />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ScheduleDialog
        key={dialog.key}
        agentId={agentId}
        open={dialog.open}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        current={schedule}
      />
    </div>
  );
};
