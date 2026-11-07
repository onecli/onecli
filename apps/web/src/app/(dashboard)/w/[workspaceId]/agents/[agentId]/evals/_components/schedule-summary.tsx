"use client";

import { CalendarClock } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import type { EvalSchedule } from "@/lib/api";
import {
  describeScheduleState,
  reportDestination,
} from "@/lib/agents/eval-schedule";
import { whenLabel } from "../../schedules/_components/schedule-grid";

/**
 * The eval schedule at a glance, under the page header: when it runs next
 * (or why it stopped), and what its last fire did. Opens the dialog.
 */
export const ScheduleSummary = ({
  schedule,
  onEdit,
}: {
  schedule: EvalSchedule;
  onEdit: () => void;
}) => {
  const { status, alert, last } = describeScheduleState(schedule);
  return (
    <div className="bg-muted/40 flex flex-wrap items-center justify-between gap-2 rounded-md px-3 py-2 text-sm">
      <div className="flex min-w-0 items-start gap-2">
        <CalendarClock
          className="text-muted-foreground mt-0.5 size-4 shrink-0"
          aria-hidden
        />
        <div className="min-w-0 space-y-0.5">
          <p>
            <span className="font-medium">
              {whenLabel(schedule.schedule) ?? schedule.schedule}
            </span>{" "}
            <span className="text-muted-foreground">({schedule.timezone})</span>
          </p>
          <p
            className={cn(
              "text-xs",
              alert ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {status}
            {last && <> · {last}</>}
            {schedule.report && (
              <>
                {" "}
                · Results to{" "}
                {reportDestination(schedule.report, schedule.createdByViewer)}
              </>
            )}
          </p>
        </div>
      </div>
      <Button size="sm" variant="ghost" onClick={onEdit}>
        Edit schedule
      </Button>
    </div>
  );
};
