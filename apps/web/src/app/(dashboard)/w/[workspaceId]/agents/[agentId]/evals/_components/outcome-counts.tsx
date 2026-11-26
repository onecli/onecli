import type {
  EvalOutcome,
  EvalOutcomeCounts,
} from "@onecli/api/validations/evals";
import { EVAL_OUTCOMES } from "@onecli/api/validations/evals";
import { cn } from "@onecli/ui/lib/utils";
import { OUTCOME_LABEL } from "./eval-copy";
import { OutcomeIcon } from "./outcome-icon";

/**
 * A run's outcome counts as icon + number pairs, zero counts left out.
 * `compact` drops the visible words (the run picker); screen readers always
 * hear "3 passed", as real text, so it also reads right inside a Select
 * option, whose children are presentational. With `onToggle`, each count
 * is a filter button (`active` marks the ones on).
 */
export const OutcomeCounts = ({
  counts,
  compact = false,
  className,
  active,
  onToggle,
}: {
  counts: EvalOutcomeCounts;
  compact?: boolean;
  className?: string;
  active?: ReadonlySet<EvalOutcome>;
  onToggle?: (outcome: EvalOutcome) => void;
}) => (
  <ul
    className={cn(
      "flex flex-wrap items-center gap-x-3 gap-y-1 text-sm",
      onToggle && "gap-x-1",
      className,
    )}
  >
    {EVAL_OUTCOMES.filter((outcome) => counts[outcome] > 0).map((outcome) => {
      const label = OUTCOME_LABEL[outcome].toLowerCase();
      const body = (
        <>
          <OutcomeIcon outcome={outcome} decorative />
          {counts[outcome]}
          <span className={cn(compact ? "sr-only" : "text-muted-foreground")}>
            {" "}
            {label}
          </span>
        </>
      );
      return (
        <li
          key={outcome}
          className="inline-flex items-center gap-1 tabular-nums"
        >
          {onToggle ? (
            <button
              type="button"
              aria-label={`Show only ${counts[outcome]} ${label}`}
              aria-pressed={active?.has(outcome) ?? false}
              onClick={() => onToggle(outcome)}
              className={cn(
                "focus-visible:ring-ring/50 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 transition-colors outline-none focus-visible:ring-2",
                active?.has(outcome)
                  ? "border-foreground/30 bg-muted"
                  : "hover:bg-muted/60 border-transparent",
              )}
            >
              {body}
            </button>
          ) : (
            body
          )}
        </li>
      );
    })}
  </ul>
);
