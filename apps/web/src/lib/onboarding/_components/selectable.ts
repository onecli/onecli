import { cn } from "@onecli/ui/lib/utils";

/**
 * Shared interaction styles for selection surfaces (the onboarding discovery
 * grid, the Slack transport picker). Centralized so focus, hover, active and
 * the selected state stay identical across every choice the user makes.
 *
 * The hover border is applied only when unselected — otherwise the `:hover`
 * pseudo-class outranks the static `border-brand` and a selected card would
 * lose its brand outline on hover.
 */
export const selectableCard = (isSelected: boolean): string =>
  cn(
    "border transition-all outline-none",
    "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
    "active:scale-[0.98]",
    isSelected
      ? "border-brand bg-brand/5"
      : "border-border bg-card hover:border-foreground/20",
  );
