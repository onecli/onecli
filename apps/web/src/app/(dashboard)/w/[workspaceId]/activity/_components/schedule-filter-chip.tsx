"use client";

import { useCrons } from "@/hooks/use-crons";
import { ClearFilterChip } from "./clear-filter-chip";

export interface ScheduleFilterChipProps {
  agentId: string;
  cronId: string;
  onClear: () => void;
}

/**
 * Shown while Runs is narrowed to one schedule (its "History"): names the
 * schedule and clears back to all of the agent's scheduled runs. The twin of
 * WebhookFilterChip; until the name loads (or if the schedule is gone) the
 * chip still clears.
 */
export const ScheduleFilterChip = ({
  agentId,
  cronId,
  onClear,
}: ScheduleFilterChipProps) => {
  const { data } = useCrons(agentId);
  const name = data?.crons.find((cron) => cron.id === cronId)?.name;

  return (
    <ClearFilterChip onClick={onClear}>
      {name ? `Schedule: ${name}` : "One schedule"}
    </ClearFilterChip>
  );
};
