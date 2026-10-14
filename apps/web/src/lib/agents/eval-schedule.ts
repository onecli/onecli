import type { EvalScheduleOutcome } from "@onecli/api/validations/evals";
import type { EvalSchedule } from "@/lib/api";
import { formatTimestamp } from "@/lib/format-timestamp";

/**
 * The eval schedule's presets and their cron expressions, pure so the
 * round trip (a saved expression back into the form) is unit tested. No
 * date library: the presets are three fixed shapes, and anything else is
 * "custom", shown as written.
 */

export type SchedulePreset = "daily" | "weekdays" | "weekly" | "custom";

export interface ScheduleDraft {
  preset: SchedulePreset;
  /** HH:MM for the presets. */
  time: string;
  custom: string;
  timezone: string;
}

type FixedPreset = Exclude<SchedulePreset, "custom">;

const DAY_PART: Record<FixedPreset, string> = {
  daily: "*",
  weekdays: "1-5",
  weekly: "1",
};

const PRESET_RE = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|1)$/;

/** A preset expression read back: which preset, at what HH:MM. Null for
 * anything else (shown and edited as a custom expression). */
const parsePreset = (
  schedule: string,
): { preset: FixedPreset; time: string } | null => {
  const [, minute, hour, days] = PRESET_RE.exec(schedule) ?? [];
  if (minute === undefined || hour === undefined) return null;
  return {
    preset: days === "1-5" ? "weekdays" : days === "1" ? "weekly" : "daily",
    time: `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`,
  };
};

/** The expression for a draft, or null when the time is not HH:MM. */
export const composeSchedule = (draft: ScheduleDraft): string | null => {
  if (draft.preset === "custom") return draft.custom.trim() || null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(draft.time.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${minute} ${hour} * * ${DAY_PART[draft.preset]}`;
};

/** A form draft from a saved schedule, or the defaults (daily 09:00). */
export const draftFromSchedule = (
  saved: { schedule: string; timezone: string } | null,
  fallbackTimezone: string,
): ScheduleDraft => {
  const base: ScheduleDraft = {
    preset: "daily",
    time: "09:00",
    custom: "0 9 * * *",
    timezone: fallbackTimezone,
  };
  if (!saved) return base;
  const preset = parsePreset(saved.schedule);
  return {
    ...base,
    ...(preset ?? { preset: "custom" }),
    custom: saved.schedule,
    timezone: saved.timezone,
  };
};

const PRESET_LABEL: Record<FixedPreset, string> = {
  daily: "Daily",
  weekdays: "Weekdays",
  weekly: "Mondays",
};

/** "Daily at 09:00" for the presets, the expression for anything else. */
export const describeSchedule = (schedule: string): string => {
  const preset = parsePreset(schedule);
  return preset
    ? `${PRESET_LABEL[preset.preset]} at ${preset.time}`
    : `Cron ${schedule}`;
};

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
