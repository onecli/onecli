"use client";

import { useState } from "react";
import { CalendarClock, Loader2, Plus } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { useAgentPageAgent } from "../../_components/agent-page-frame";
import { useCrons } from "@/hooks/use-crons";
import type { AgentCron } from "@/lib/api";
import { CronRow } from "./cron-row";
import { CronDialog } from "./cron-dialog";

/**
 * The agent's Schedules section (step 7). Reports land in the chat the
 * schedule was created from, so this section is the MANAGEMENT surface only:
 * rows, the pause switch, run-now, and the create/edit dialog.
 */
export const SchedulesSection = () => {
  const agent = useAgentPageAgent();
  const view = useCrons(agent.id);
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

  if (view.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
        <span className="sr-only">Loading schedules</span>
      </div>
    );
  }

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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Schedules</h2>
          <p className="text-muted-foreground text-sm">
            Tasks this agent runs on its own, on a repeating schedule or once at
            a set time. Each run reports back to the chat the schedule was
            created from.
          </p>
        </div>
        {crons.length > 0 && (
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" />
            New schedule
          </Button>
        )}
      </div>

      {crons.length === 0 ? (
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
