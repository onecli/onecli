"use client";

import { Ban, CircleCheck, Hand, Lock } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";

/** The per-tool decision the dialog edits; compiles to the grants API's
 * allow / ask sets (never = the complement). */
export type ToolChoice = "allow" | "ask" | "never";

const OPTIONS = [
  {
    value: "allow",
    label: "Always allow",
    icon: CircleCheck,
    active: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  {
    value: "ask",
    label: "Needs approval",
    icon: Hand,
    active: "bg-blue-500/10 text-blue-500",
  },
  {
    value: "never",
    label: "Never",
    icon: Ban,
    active: "bg-destructive/10 text-destructive",
  },
] as const satisfies readonly {
  value: ToolChoice;
  label: string;
  icon: typeof CircleCheck;
  active: string;
}[];

interface TriStateControlProps {
  value: ToolChoice;
  onSelect: (value: ToolChoice) => void;
  /** Org-ceiling locks: a disabled option renders muted and inert, with the
   * reason in its tooltip. */
  isOptionDisabled?: (value: ToolChoice) => { disabled: boolean; why?: string };
  /** Whole-control disable (saving, read-only org-granted view). */
  disabled?: boolean;
  /** Plan lock on Needs approval: the option stays CLICKABLE (the click routes
   * through the paywall guard) and wears a mini lock badge. */
  askLocked?: boolean;
}

/** The icon-only tri-state segmented control (the recovered pre-step-10
 * `permission-buttons` design, "Block" renamed "Never"). Plain buttons with
 * `aria-pressed` per the house segmented pattern. */
export const TriStateControl = ({
  value,
  onSelect,
  isOptionDisabled,
  disabled,
  askLocked,
}: TriStateControlProps) => (
  <div role="group" className="flex items-center gap-0.5">
    {OPTIONS.map((option) => {
      const gate = isOptionDisabled?.(option.value) ?? { disabled: false };
      const isActive = value === option.value;
      const planLocked = option.value === "ask" && askLocked === true;
      const Icon = option.icon;
      const label =
        gate.why ?? (planLocked ? `${option.label} · Team` : option.label);
      return (
        <Tooltip key={option.value}>
          <TooltipTrigger asChild>
            <span className={cn(gate.disabled && "pointer-events-auto")}>
              <button
                type="button"
                aria-pressed={isActive}
                aria-label={option.label}
                disabled={disabled || gate.disabled}
                onClick={() => onSelect(option.value)}
                className={cn(
                  "focus-visible:ring-ring relative flex size-8 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none",
                  isActive
                    ? option.active
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  (disabled || gate.disabled) &&
                    "cursor-not-allowed opacity-40 hover:bg-transparent",
                )}
              >
                <Icon
                  className={cn("size-4", isActive && "stroke-[2.5]")}
                  aria-hidden
                />
                {planLocked && (
                  <Lock
                    className="text-muted-foreground absolute -top-1 -right-1 size-3"
                    aria-hidden
                  />
                )}
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">{label}</TooltipContent>
        </Tooltip>
      );
    })}
  </div>
);
