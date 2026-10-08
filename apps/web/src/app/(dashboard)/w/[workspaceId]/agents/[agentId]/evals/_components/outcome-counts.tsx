import type { EvalOutcomeCounts } from "@onecli/api/validations/evals";
import { EVAL_OUTCOMES } from "@onecli/api/validations/evals";
import { cn } from "@onecli/ui/lib/utils";
import { OUTCOME_LABEL } from "./eval-copy";
import { OutcomeIcon } from "./outcome-icon";

/**
 * A run's outcome counts as icon + number pairs, zero counts left out.
 * `compact` drops the visible words (the run picker); screen readers always
 * hear "3 passed", as real text, so it also reads right inside a Select
 * option, whose children are presentational.
 */
export const OutcomeCounts = ({
  counts,
  compact = false,
  className,
}: {
  counts: EvalOutcomeCounts;
  compact?: boolean;
  className?: string;
}) => (
  <ul
    className={cn(
      "flex flex-wrap items-center gap-x-3 gap-y-1 text-sm",
      className,
    )}
  >
    {EVAL_OUTCOMES.filter((outcome) => counts[outcome] > 0).map((outcome) => {
      const label = OUTCOME_LABEL[outcome].toLowerCase();
      return (
        <li
          key={outcome}
          className="inline-flex items-center gap-1 tabular-nums"
        >
          <OutcomeIcon outcome={outcome} decorative />
          {counts[outcome]}
          <span className={cn(compact ? "sr-only" : "text-muted-foreground")}>
            {" "}
            {label}
          </span>
        </li>
      );
    })}
  </ul>
);
