"use client";

import { cn } from "@onecli/ui/lib/utils";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

/** Activity's segmented filter, shared by the Network and Runs tabs so both
 *  read and behave the same. */
export const SegmentedFilter = <T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) => (
  <div
    role="group"
    aria-label={label}
    className="flex flex-wrap items-center gap-1 rounded-lg border p-1"
  >
    {options.map((option) => {
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
