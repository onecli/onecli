"use client";

import { useId } from "react";
import type { OAuthAccessLevels } from "@onecli/api/apps/types";
import { RadioGroup, RadioGroupItem } from "@onecli/ui/components/radio-group";
import { cn } from "@onecli/ui/lib/utils";
import { selectableCard } from "@/lib/onboarding/_components/selectable";

export interface AccessLevelSelectProps {
  levels: OAuthAccessLevels;
  value: string;
  onChange: (value: string) => void;
}

/**
 * The token-level choice for providers that issue more than one kind of OAuth
 * token (e.g. Attio's workspace vs personal access). Every option shows its
 * explanation, so the user can compare what each grants before leaving for
 * the provider. A radio group: one Tab stop, arrow keys move the choice.
 */
export const AccessLevelSelect = ({
  levels,
  value,
  onChange,
}: AccessLevelSelectProps) => {
  const id = useId();
  const labelId = `${id}-label`;
  return (
    <div className="space-y-2">
      <p id={labelId} className="text-xs font-medium text-muted-foreground">
        {levels.label}
      </p>
      <RadioGroup
        value={value}
        onValueChange={onChange}
        aria-labelledby={labelId}
        className="gap-2"
      >
        {levels.options.map((option) => {
          const optionId = `${id}-${option.value}`;
          // The whole card is the click target; the radio's name is the
          // title alone, and the description is read as its description.
          return (
            <label
              key={option.value}
              htmlFor={optionId}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5",
                "has-focus-visible:border-ring has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50",
                selectableCard(option.value === value),
              )}
            >
              <RadioGroupItem
                id={optionId}
                value={option.value}
                aria-labelledby={`${optionId}-title`}
                aria-describedby={`${optionId}-description`}
                className="mt-0.5"
              />
              <span className="space-y-0.5">
                <span
                  id={`${optionId}-title`}
                  className="block text-sm font-medium"
                >
                  {option.label}
                </span>
                <span
                  id={`${optionId}-description`}
                  className="block text-xs leading-relaxed text-muted-foreground"
                >
                  {option.description}
                </span>
              </span>
            </label>
          );
        })}
      </RadioGroup>
    </div>
  );
};
