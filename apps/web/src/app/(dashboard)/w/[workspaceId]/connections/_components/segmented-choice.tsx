"use client";

import { cn } from "@onecli/ui/lib/utils";

const ARROW_STEP: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

export interface SegmentedChoiceProps<T extends string> {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onValueChange: (value: T) => void;
  /** The id of the element that names the group. */
  labelledBy: string;
  className?: string;
}

/**
 * A compact single choice: a WAI-ARIA radio group with roving tabindex and
 * arrow-key movement (the Slack transport picker's contract), drawn as one
 * row of segments.
 */
export const SegmentedChoice = <T extends string>({
  options,
  value,
  onValueChange,
  labelledBy,
  className,
}: SegmentedChoiceProps<T>) => (
  <div
    role="radiogroup"
    aria-labelledby={labelledBy}
    className={cn("flex items-center gap-1 rounded-lg border p-1", className)}
    onKeyDown={(event) => {
      const step = ARROW_STEP[event.key];
      if (!step) return;
      event.preventDefault();
      const index = options.findIndex((option) => option.value === value);
      const nextIndex = (index + step + options.length) % options.length;
      const next = options[nextIndex];
      if (!next) return;
      onValueChange(next.value);
      event.currentTarget
        .querySelectorAll<HTMLButtonElement>('[role="radio"]')
        [nextIndex]?.focus();
    }}
  >
    {options.map((option) => {
      const selected = option.value === value;
      return (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={selected}
          tabIndex={selected ? 0 : -1}
          onClick={() => onValueChange(option.value)}
          className={cn(
            "flex-1 rounded-md px-2 py-1 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]",
            selected
              ? "bg-brand/10 text-brand"
              : "text-muted-foreground hover:bg-brand/5 hover:text-brand/80",
          )}
        >
          {option.label}
        </button>
      );
    })}
  </div>
);
