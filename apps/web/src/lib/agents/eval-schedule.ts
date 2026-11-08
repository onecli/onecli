import type { EvalScheduleOutcome } from "@onecli/api/validations/evals";
import type { EvalSchedule } from "@/lib/api";
import { formatTimestamp } from "@/lib/format-timestamp";

const LAST_OUTCOME_LABEL: Record<EvalScheduleOutcome, string> = {
  started: "Last scheduled run started",
  skipped_busy: "Last scheduled run skipped: a run was already going",
  skipped_no_questions: "Last scheduled run skipped: no test questions",
  failed: "Last scheduled run could not start",
};

/**
 * The schedule's state in words, the one source for the Evals summary and
 * the Schedules row: when it runs next, or why it stopped (`alert` when the
 * reader must act), then what its last fire did, and when.
 */
export const describeScheduleState = (
  schedule: EvalSchedule,
): { status: string; alert: boolean; last: string | null } => {
  const status = schedule.enabled
    ? `Next run ${formatTimestamp(schedule.nextFireAt)}`
    : schedule.disabledReason === "authorization"
      ? "Paused: whoever set it up no longer has access. Save it again to resume it as you."
      : schedule.disabledReason === "completed"
        ? "Finished: this schedule has no more runs."
        : "Paused";
  const outcome =
    schedule.lastOutcome && LAST_OUTCOME_LABEL[schedule.lastOutcome];
  const last = !outcome
    ? null
    : schedule.lastFiredAt
      ? `${outcome} ${formatTimestamp(schedule.lastFiredAt)}`
      : outcome;
  return {
    status,
    alert: !schedule.enabled && schedule.disabledReason === "authorization",
    last,
  };
};

/** Where a scheduled run's results go, in words for THIS viewer: results
 * sent to "chat" go to whoever last saved the schedule, which is "your
 * chat" only when that is the viewer. */
export const reportDestination = (
  report: NonNullable<EvalSchedule["report"]>,
  createdByViewer: boolean,
): string =>
  report.to === "channel"
    ? report.channelLabel
    : createdByViewer
      ? "your chat"
      : "a teammate's chat";
