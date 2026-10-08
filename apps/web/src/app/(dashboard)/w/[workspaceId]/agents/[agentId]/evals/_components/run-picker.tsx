"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import type { EvalRunSummary } from "@/lib/api";
import { formatTimestamp } from "@/lib/format-timestamp";
import { OutcomeCounts } from "./outcome-counts";

/** Pick a run from the history: when it ran and its outcome counts. */
export const RunPicker = ({
  runs,
  value,
  onValueChange,
}: {
  runs: EvalRunSummary[];
  value: string;
  onValueChange: (runId: string) => void;
}) => (
  <Select value={value} onValueChange={onValueChange}>
    <SelectTrigger
      size="sm"
      aria-label="Test run"
      className="max-w-full *:data-[slot=select-value]:min-w-0"
    >
      <SelectValue />
    </SelectTrigger>
    <SelectContent
      position="popper"
      align="end"
      className="max-w-[calc(100vw-2rem)]"
    >
      {runs.map((run, index) => (
        <SelectItem key={run.id} value={run.id}>
          <span className="flex min-w-0 items-center gap-3">
            <span className="truncate">
              {formatTimestamp(run.createdAt)}
              {index === 0 && (
                <span className="text-muted-foreground"> · latest</span>
              )}
              {run.status === "failed" && (
                <span className="text-destructive"> · stopped</span>
              )}
            </span>
            <OutcomeCounts counts={run.counts} compact className="text-xs" />
          </span>
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);
