"use client";

import { cn } from "@onecli/ui/lib/utils";
import type { BillingInterval } from "@onecli/api/ee/billing/plans";

export interface BillingIntervalToggleProps {
  value: BillingInterval;
  onChange: (value: BillingInterval) => void;
  /** Disables both segments (e.g. while a plan switch is in flight). */
  disabled?: boolean;
}

/**
 * Monthly/Yearly segmented control — matches the system's activity-filter
 * pattern (bordered container, flat `bg-muted` active segment). The savings
 * badge lives inside the Yearly segment so it reads as the yearly perk.
 */
export const BillingIntervalToggle = ({
  value,
  onChange,
  disabled,
}: BillingIntervalToggleProps) => {
  const segment = (interval: BillingInterval) =>
    cn(
      "inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors",
      "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
      value === interval
        ? "bg-muted text-foreground"
        : "text-muted-foreground hover:text-foreground",
    );

  return (
    <div
      role="group"
      aria-label="Billing interval"
      className={cn(
        "inline-flex items-center gap-1 rounded-lg border p-1",
        disabled && "opacity-50",
      )}
    >
      <button
        type="button"
        disabled={disabled}
        aria-pressed={value === "month"}
        onClick={() => onChange("month")}
        className={segment("month")}
      >
        Monthly
      </button>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={value === "year"}
        onClick={() => onChange("year")}
        className={segment("year")}
      >
        Yearly
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[10px] font-semibold transition-colors",
            value === "year"
              ? "bg-brand/15 text-brand"
              : "bg-brand/10 text-brand/90",
          )}
        >
          2 months free
        </span>
      </button>
    </div>
  );
};
