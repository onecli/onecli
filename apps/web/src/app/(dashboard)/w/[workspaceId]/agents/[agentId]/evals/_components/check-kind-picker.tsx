"use client";

import {
  EVAL_CHECK_KINDS,
  type EvalCheckKind,
} from "@onecli/api/validations/evals";
import { cn } from "@onecli/ui/lib/utils";
import { selectableCard } from "@/lib/onboarding/_components/selectable";
import { CHECK_LABEL } from "./eval-copy";

const DESCRIPTION: Record<EvalCheckKind, string> = {
  numeric: "Passes when any number in the answer is within 0.5%.",
  text: "Passes when every significant expected word appears.",
};

/**
 * How the answer is checked: a WAI-ARIA radio group with roving tabindex and
 * arrow-key movement (the Slack transport picker's contract). A surrounding
 * disabled `<fieldset>` disables it.
 */
export const CheckKindPicker = ({
  labelledBy,
  value,
  onValueChange,
}: {
  /** The id of the element that names the group. */
  labelledBy: string;
  value: EvalCheckKind;
  onValueChange: (kind: EvalCheckKind) => void;
}) => (
  <div
    role="radiogroup"
    aria-labelledby={labelledBy}
    className="grid gap-2 sm:grid-cols-2"
    onKeyDown={(event) => {
      if (
        !["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)
      )
        return;
      event.preventDefault();
      const step =
        event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
      const index = EVAL_CHECK_KINDS.indexOf(value);
      const nextIndex =
        (index + step + EVAL_CHECK_KINDS.length) % EVAL_CHECK_KINDS.length;
      const next = EVAL_CHECK_KINDS[nextIndex];
      if (!next) return;
      onValueChange(next);
      event.currentTarget
        .querySelectorAll<HTMLButtonElement>('[role="radio"]')
        [nextIndex]?.focus();
    }}
  >
    {EVAL_CHECK_KINDS.map((kind) => (
      <button
        key={kind}
        type="button"
        role="radio"
        aria-checked={value === kind}
        tabIndex={value === kind ? 0 : -1}
        onClick={() => onValueChange(kind)}
        className={cn(
          "rounded-lg p-3 text-start disabled:opacity-50",
          selectableCard(value === kind),
        )}
      >
        <span className="block text-sm font-medium">{CHECK_LABEL[kind]}</span>
        <span className="text-muted-foreground mt-0.5 block text-xs">
          {DESCRIPTION[kind]}
        </span>
      </button>
    ))}
  </div>
);
