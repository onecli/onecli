import { Loader2 } from "lucide-react";
import { isActiveEvalRun } from "@onecli/api/validations/evals";
import { Progress } from "@onecli/ui/components/progress";
import type { EvalRunDetail } from "@/lib/api";
import { plural } from "./eval-copy";
import { OutcomeCounts } from "./outcome-counts";

/** A run's tally, its live progress while active, and why it stopped. */
export const RunStatusHeader = ({ run }: { run: EvalRunDetail }) => {
  const active = isActiveEvalRun(run.status);
  const done = run.total - run.counts.pending;
  return (
    <div className="space-y-3 border-b p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <OutcomeCounts counts={run.counts} />
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
