"use client";

import { cn } from "@onecli/ui/lib/utils";
import type { ActivityFilter } from "@onecli/api/services/request-log-service";

interface ActivityFilterOption {
  value: ActivityFilter;
  label: string;
}

const OPTIONS: ActivityFilterOption[] = [
  { value: "all", label: "All" },
  { value: "hide-llm", label: "Hide AI" },
  { value: "blocked", label: "Blocked" },
];

interface ActivityFilterControlProps {
  value: ActivityFilter;
  onChange: (value: ActivityFilter) => void;
}

export const ActivityFilterControl = ({
  value,
  onChange,
}: ActivityFilterControlProps) => (
  <div
    role="group"
    aria-label="Filter activity"
    className="flex items-center gap-1 rounded-lg border p-1"
  >
    {OPTIONS.map((option) => {
      const selected = value === option.value;
      return (
        <button
          key={option.value}
          type="button"
          aria-pressed={selected}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-md px-3 py-1 text-xs font-medium transition-colors focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
            selected
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      );
    })}
  </div>
);
