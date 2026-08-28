"use client";

import { Pencil, Play } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import { Switch } from "@onecli/ui/components/switch";
import { useRunCronNow, useUpdateCron } from "@/hooks/use-crons";
import type { AgentCron } from "@/lib/api";

export interface CronRowProps {
  agentId: string;
  cron: AgentCron;
  onEdit: () => void;
}

const nextFireLabel = (cron: AgentCron): string => {
  if (cron.disabledReason === "completed") return "Completed";
  if (!cron.enabled) return "Paused";
  const next = new Date(cron.nextFireAt);
  return `Next: ${next.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
};

const outcomeLabel = (cron: AgentCron): string | null => {
  switch (cron.lastOutcome) {
    case "ok":
      return "Last run succeeded";
    case "failed":
      return "Last run failed";
    case "skipped_busy":
      return "Last fire skipped: previous run was still going";
    default:
      return null;
  }
};

export const CronRow = ({ agentId, cron, onEdit }: CronRowProps) => {
  const update = useUpdateCron(agentId);
  const runNow = useRunCronNow(agentId);
  const outcome = outcomeLabel(cron);

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{cron.name}</span>
          {/* The switch is the status; this badge appears only for states the
              switch cannot express — the platform turned it off. A completed
              one-shot is terminal by DESIGN, so it reads neutral, never
              destructive. */}
          {cron.disabledReason === "completed" ? (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
              Completed
            </Badge>
          ) : (
            cron.disabledReason && (
              <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
                Auto-disabled
                {cron.disabledReason === "authorization"
                  ? ": creator lost access"
                  : ": kept failing"}
              </Badge>
            )
          )}
        </div>
        <div className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
          <span className="font-mono">{cron.schedule}</span>
          <span>{cron.timezone}</span>
          <span>{nextFireLabel(cron)}</span>
          {outcome && <span className="truncate">{outcome}</span>}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="ghost"
          size="xs"
          disabled={!cron.enabled || runNow.isPending}
          loading={runNow.isPending}
          onClick={() =>
            runNow.mutate(cron.id, {
              onSuccess: () =>
                toast.success(`"${cron.name}" will run in a moment`),
              onError: (error) => toast.error(String(error.message)),
            })
          }
        >
          <Play className="size-3.5" />
          Run now
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Edit ${cron.name}`}
          onClick={onEdit}
        >
          <Pencil className="size-3.5" />
        </Button>
        <Switch
          size="sm"
          checked={cron.enabled}
          disabled={update.isPending}
          aria-label={`${cron.enabled ? "Pause" : "Resume"} ${cron.name}`}
          onCheckedChange={(next) =>
            update.mutate(
              { cronId: cron.id, input: { enabled: next } },
              {
                onSuccess: () =>
                  toast.success(
                    next ? `"${cron.name}" resumed` : `"${cron.name}" paused`,
                  ),
                onError: (error) => toast.error(String(error.message)),
              },
            )
          }
        />
      </div>
    </div>
  );
};
