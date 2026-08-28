"use client";

import { AlarmClock, CalendarClock, type LucideIcon } from "lucide-react";
import type { AutomationSource } from "@/lib/chat/turns";

/**
 * A platform-posted report — a scheduled run (cron) or a process watch firing
 * (watch) — materialized into the origin thread as a completed turn. The person
 * did NOT type `title`; the platform did (e.g. `Watch on "sleep 90;"`), so it
 * must never wear the user's bubble. A quiet, start-aligned system label
 * instead, introducing the report body the agent-side block renders below it.
 *
 * The cron icon matches the schedules section (`CalendarClock`) so a report and
 * its schedule read as one thing; watches get `AlarmClock` — a process the
 * agent set to watch — deliberately not a `Zap` (per the UI-taste rule).
 */
const AUTOMATION_ICON: Record<AutomationSource, LucideIcon> = {
  cron: CalendarClock,
  watch: AlarmClock,
};

export const AutomationTurnHeader = ({
  source,
  title,
}: {
  source: AutomationSource;
  title: string;
}) => {
  const Icon = AUTOMATION_ICON[source];
  return (
    <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {/* `title` recovers the tail of a long header (up to ~100 chars) on
          hover when the column truncates it. */}
      <span className="min-w-0 truncate" title={title}>
        {title}
      </span>
    </div>
  );
};
