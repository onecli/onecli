"use client";

import { PageHeader } from "@dashboard/page-header";
import { useState } from "react";
import Link from "next/link";
import { CalendarClock, History, Plus } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { useAgentPageAgent } from "../../_components/agent-page-frame";
import { useCrons } from "@/hooks/use-crons";
import { useEvals } from "@/hooks/use-evals";
import type { AgentCron } from "@/lib/api";
import { useAgentActivityPaths } from "@/lib/dashboard/use-agent-activity-paths";
import { CronRow } from "./cron-row";
import { CronDialog } from "./cron-dialog";
import { EvalScheduleRow } from "./eval-schedule-row";
import { SCHEDULE_GRID } from "./schedule-grid";
import { cn } from "@onecli/ui/lib/utils";
import { SectionSkeleton } from "@/lib/dashboard/shell/section-skeleton";

/**
 * The agent's Schedules section (step 7). Reports land in the chat the
 * schedule was created from, so this section is the MANAGEMENT surface only:
 * rows, the pause switch, run-now, and the create/edit dialog. The agent's
 * eval schedule is listed here too (read from the evals view, managed on the
 * Evals page), so everything the agent runs on its own shows in one place.
 */
export const SchedulesSection = () => {
  const agent = useAgentPageAgent();
  const activityPaths = useAgentActivityPaths();
  const view = useCrons(agent.id);
  // Best-effort: the eval row is extra context, so an evals failure never
  // blocks the crons list (it only leaves that row out).
  const evalsView = useEvals(agent.id);
  const evals = evalsView.data;
  const evalSchedule = evals?.schedule ?? null;
  // The newest eval run, scheduled or started by hand: its row shows it
  // running like a cron's.
  const latestEvalRun = evals?.runs[0] ?? null;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AgentCron | null>(null);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (cron: AgentCron) => {
    setEditing(cron);
    setDialogOpen(true);
  };

  if (view.isPending) return <SectionSkeleton label="Loading schedules" />;

  // Never render toggle rows over a failed load — a blind toggle would write
  // against invisible state (the apps-tab law).
  if (view.isError) {
    return (
      <div
        role="alert"
        className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border p-4 text-sm"
      >
        Schedules failed to load. Refresh to try again.
      </div>
    );
  }

  const crons = view.data.crons;
  const empty = crons.length === 0 && !evalSchedule;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Schedules"
        character="cloud-wait"
        description="Tasks the agent runs on a schedule. Results go to the chat they were created from."
        action={
          !empty && (
            <div className="flex shrink-0 items-center gap-2">
              {/* The runs list filters by source, not by schedule, so this
                is one link for all of the agent's scheduled runs. The eval
                schedule's runs live on the Evals page. */}
              {crons.length > 0 && (
                <Button asChild size="sm" variant="ghost">
                  <Link href={activityPaths.runs(agent.id, "cron")}>
                    <History className="size-4" />
                    Run history
                  </Link>
                </Button>
              )}
              <Button size="sm" onClick={openCreate}>
                <Plus className="size-4" />
                New schedule
              </Button>
            </div>
          )
        }
      />

      {empty ? (
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          <div className="bg-muted flex size-10 items-center justify-center rounded-full">
            <CalendarClock className="text-muted-foreground size-5" />
          </div>
          <div>
            <p className="text-sm font-medium">No schedules yet</p>
            <p className="text-muted-foreground mt-1 text-sm">
              Create one here, or just ask the agent in chat: “check the inbox
              every morning at 9:00”.
            </p>
          </div>
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" />
            New schedule
          </Button>
        </Card>
      ) : (
        <div className="divide-y rounded-md border">
          <div
            className={cn(
              SCHEDULE_GRID,
              "text-muted-foreground hidden px-4 py-2 text-xs font-medium md:grid",
            )}
          >
            <span>Name</span>
            <span>When</span>
            <span>Next run</span>
            <span>Last run</span>
            <span />
          </div>
          {evalSchedule && (
            <EvalScheduleRow
              agentId={agent.id}
              schedule={evalSchedule}
              latestRun={latestEvalRun}
              refetch={evalsView.refetch}
            />
          )}
          {crons.map((cron) => (
            <CronRow
              key={cron.id}
              agentId={agent.id}
              cron={cron}
              onEdit={() => openEdit(cron)}
            />
          ))}
        </div>
      )}

      <CronDialog
        agentId={agent.id}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
      />
    </div>
  );
};
