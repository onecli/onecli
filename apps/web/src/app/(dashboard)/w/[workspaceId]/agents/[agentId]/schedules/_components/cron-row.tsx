"use client";

import {
  Filter,
  History,
  MoreHorizontal,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import {
  useDeleteCron,
  useCrons,
  useRunCronNow,
  useSetCronEnabled,
} from "@/hooks/use-crons";
import type { AgentCron } from "@/lib/api";
import type { CronOutcome } from "@onecli/api/validations/crons";
import { agentScheduleRunsPath } from "@/lib/navigation";
import { cn } from "@onecli/ui/lib/utils";
import {
  SCHEDULE_CELL,
  SCHEDULE_GRID,
  formatWhen,
  nextRunLabel,
  whenLabel,
} from "./schedule-grid";
import { RunDot, type RunTone } from "./run-dot";
import { LastRunLink } from "./last-run-link";
import { CheckRunButton } from "./check-run-button";
import { DisabledReason } from "./disabled-reason";

export interface CronRowProps {
  agentId: string;
  cron: AgentCron;
  onEdit: () => void;
}

const OUTCOME_LABEL: Record<CronOutcome, string> = {
  ok: "Last run succeeded",
  failed: "Last run failed",
  stopped: "Last run was stopped",
  skipped_busy: "Skipped: the previous run was still going",
};

const OUTCOME_TONE: Record<CronOutcome, RunTone> = {
  ok: "ok",
  failed: "failed",
  stopped: "skipped",
  skipped_busy: "skipped",
};

export const CronRow = ({ agentId, cron, onEdit }: CronRowProps) => {
  const setEnabled = useSetCronEnabled(agentId);
  const runNow = useRunCronNow(agentId);
  const { refetch } = useCrons(agentId);
  const remove = useDeleteCron(agentId);
  const pathname = usePathname();
  const outcome = cron.lastOutcome && OUTCOME_LABEL[cron.lastOutcome];

  return (
    <div className={cn(SCHEDULE_GRID, "px-4 py-3")}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span title={cron.name} className="truncate text-sm font-medium">
            {cron.name}
          </span>
          {/* The switch is the status; this badge appears only when the
              platform turned it off. A finished one-shot needs none: Next
              run says "Already ran". */}
          {cron.disabledReason && cron.disabledReason !== "completed" && (
            <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
              Auto-disabled
              {cron.disabledReason === "authorization"
                ? ": creator lost access"
                : ": kept failing"}
            </Badge>
          )}
        </div>
      </div>

      {/* When it runs is what a person scans for: plain words in green; the
          expression and zone are a hover away. A run condition is a filter
          icon after the time, so times stay aligned, explained on hover. */}
      <div className={cn(SCHEDULE_CELL, "md:flex md:items-center md:gap-1.5")}>
        <span
          title={`${cron.schedule} · ${cron.timezone}`}
          className="truncate font-medium text-emerald-700 dark:text-emerald-400"
        >
          {whenLabel(cron.schedule) ?? (
            <span className="font-mono">{cron.schedule}</span>
          )}
        </span>
        {cron.gate && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Filter
                className="text-muted-foreground size-3.5 shrink-0"
                aria-label="Conditional"
              />
            </TooltipTrigger>
            <TooltipContent className="max-w-64">
              Conditional: a quick check runs on this schedule, and the agent
              only runs when:
              <span className="mt-1 block font-medium">
                {cron.gateDescription ?? "the check finds something"}
              </span>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      <span className={cn(SCHEDULE_CELL, "text-muted-foreground")}>
        {nextRunLabel(cron)}
      </span>
      {/* The dot says how the last run went: green ok, yellow running, red
          failed, grey stopped or skipped. A run in progress has its start
          time a hover away and a button to check whether it finished. */}
      <span
        title={
          cron.running && cron.lastFiredAt
            ? `Started ${formatWhen(cron.lastFiredAt)}`
            : (outcome ?? undefined)
        }
        className={cn(
          SCHEDULE_CELL,
          "text-muted-foreground md:flex md:items-center md:gap-1.5",
        )}
      >
        {cron.running ? (
          <>
            <LastRunLink agentId={agentId} cronId={cron.id}>
              <RunDot tone="running" />
              <span className="truncate">Running now</span>
            </LastRunLink>
            <CheckRunButton refetch={refetch} />
          </>
        ) : cron.lastFiredAt ? (
          <LastRunLink agentId={agentId} cronId={cron.id}>
            <RunDot
              label={outcome ?? undefined}
              tone={
                cron.lastOutcome ? OUTCOME_TONE[cron.lastOutcome] : "skipped"
              }
            />
            <span className="truncate">
              {cron.lastOutcome === "stopped"
                ? `Stopped, ${formatWhen(cron.lastFiredAt)}`
                : formatWhen(cron.lastFiredAt)}
            </span>
          </LastRunLink>
        ) : (
          "Never yet"
        )}
      </span>

      <div className="flex shrink-0 items-center justify-end gap-2">
        <DisabledReason
          reason={
            cron.running
              ? "It's running now."
              : !cron.enabled && cron.disabledReason !== "completed"
                ? "The schedule is paused. Turn it on to run it."
                : null
          }
        >
          <Button
            variant="ghost"
            size="xs"
            // A finished one-shot can still be run again by hand; only a
            // paused schedule (or one already running) can't.
            disabled={
              (!cron.enabled && cron.disabledReason !== "completed") ||
              runNow.isPending ||
              cron.running
            }
            title={
              cron.disabledReason === "completed"
                ? "It already ran. Run now runs it once more."
                : undefined
            }
            loading={runNow.isPending}
            onClick={() =>
              runNow.mutate(cron.id, {
                onSuccess: () =>
                  toast.success(
                    cron.disabledReason === "completed"
                      ? `"${cron.name}" already ran. Running it once more`
                      : `"${cron.name}" will run in a moment`,
                  ),
                onError: (error) => toast.error(String(error.message)),
              })
            }
          >
            <Play className="size-3.5" />
            Run now
          </Button>
        </DisabledReason>
        <Switch
          size="sm"
          checked={cron.enabled}
          // A one-shot past its time can never fire again on its own, so
          // there is nothing to turn back on (Run now still re-runs it).
          disabled={cron.disabledReason === "completed"}
          // Instant, never frozen while saving: the switch IS the status, so
          // its move is the confirmation; a failure puts it back and says why.
          aria-label={`${cron.enabled ? "Pause" : "Resume"} ${cron.name}`}
          onCheckedChange={(next) =>
            setEnabled.mutate({ cronId: cron.id, enabled: next })
          }
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`More for ${cron.name}`}
            >
              <MoreHorizontal className="size-3.5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil className="size-4" aria-hidden />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={agentScheduleRunsPath(pathname, agentId, cron.id)}>
                <History className="size-4" aria-hidden />
                History
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => remove.mutate(cron.id)}
            >
              <Trash2 className="size-4" aria-hidden />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
};
