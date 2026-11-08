import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import {
  isActiveEvalRun,
  type EvalOutcome,
} from "@onecli/api/validations/evals";
import { Progress } from "@onecli/ui/components/progress";
import type { EvalRunDetail } from "@/lib/api";
import { plural } from "./eval-copy";
import { OutcomeCounts } from "./outcome-counts";

/** A run's tally, its live progress while active, and why it stopped.
 * `action` sits at the end of the tally row (Expand all). */
export const RunStatusHeader = ({
  run,
  action,
  filter,
  onToggleFilter,
}: {
  run: EvalRunDetail;
  action?: ReactNode;
  /** Outcomes the list is filtered to; empty = all. */
  filter?: ReadonlySet<EvalOutcome>;
  onToggleFilter?: (outcome: EvalOutcome) => void;
}) => {
  const active = isActiveEvalRun(run.status);
  const done = run.total - run.counts.pending;
  return (
    <div className="space-y-3 border-b p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <OutcomeCounts
          counts={run.counts}
          active={filter}
          onToggle={onToggleFilter}
        />
        <div className="flex items-center gap-3">
          {active && (
            <span
              role="status"
              className="text-muted-foreground flex items-center gap-2 text-sm"
            >
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {done < run.total
                ? `Asking ${done + 1} of ${run.total}`
                : "Finishing…"}
            </span>
          )}
          {action}
        </div>
      </div>
      {active && (
        <Progress
          value={run.total > 0 ? (done / run.total) * 100 : 0}
          aria-label={`${done} of ${plural(run.total, "question", "questions")} checked`}
        />
      )}
      {run.status === "failed" && run.error && (
        <p role="alert" className="text-destructive text-sm">
          This run stopped early: {run.error}
        </p>
      )}
    </div>
  );
};
