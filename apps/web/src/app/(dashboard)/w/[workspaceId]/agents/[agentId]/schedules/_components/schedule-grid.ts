import { cronToHuman } from "@/lib/agents/human-schedule";

/**
 * The Schedules table's columns, shared by its header and its rows so they
 * line up (the Contacts table's pattern): Name | When | Next run | Last run
 * | actions. Below md the When / Next / Last cells drop out and the row
 * keeps its name and actions. Every column but the name is a fixed width,
 * so the header and each row resolve to the same tracks.
 */
export const SCHEDULE_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 md:grid-cols-[minmax(0,1fr)_160px_130px_130px_170px]";

/** A data cell that only shows at md and up. */
export const SCHEDULE_CELL = "hidden truncate text-xs md:block";

/** "Oct 30, 09:00 AM": one date style for every schedule's Next / Last. */
export const formatWhen = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/** The one-shot shape: an ISO local datetime, fired once. */
const isOnce = (schedule: string) => /^\d{4}-\d{2}-\d{2}T/.test(schedule);

/** The When cell's words, for any schedule: plain words when the parser can
 * say them, "Once, Oct 30, 09:00 AM" for a one-shot, else null (the row
 * shows the raw expression). */
export const whenLabel = (schedule: string): string | null =>
  isOnce(schedule) ? `Once, ${formatWhen(schedule)}` : cronToHuman(schedule);

/** The Next run cell's words, for any schedule. */
export const nextRunLabel = (s: {
  enabled: boolean;
  disabledReason: string | null;
  nextFireAt: string;
}): string => {
  // A one-shot that fired is done: the server marks it completed.
  if (s.disabledReason === "completed") return "Already ran";
  if (!s.enabled) return "Paused";
  return formatWhen(s.nextFireAt);
};
