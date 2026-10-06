"use client";

import { cn } from "@onecli/ui/lib/utils";
import type { OAuthConfigFieldOption } from "@onecli/api/apps/types";

interface ConfigFieldOptionsProps {
  /** id of the field's `<Label>`; the group is announced by it. */
  labelId: string;
  options: OAuthConfigFieldOption[];
  value: string;
  onChange: (value: string) => void;
}

/**
 * The segmented control for a config field with fixed `options` (e.g.
 * Salesforce's production / sandbox environment). Plain buttons with
 * `aria-pressed` per the house segmented pattern (activity-filter,
 * billing-interval-toggle); the field's label names the group.
 */
export const ConfigFieldOptions = ({
  labelId,
  options,
  value,
  onChange,
}: ConfigFieldOptionsProps) => (
  <div
    role="group"
    aria-labelledby={labelId}
    className="inline-flex w-fit items-center gap-1 rounded-lg border p-1"
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
            "rounded-md px-3 py-1 text-sm transition-colors focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
            selected
              ? "bg-muted text-foreground font-medium"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      );
    })}
  </div>
);
