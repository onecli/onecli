import { Check, X } from "lucide-react";
import type { EvalResultView } from "@onecli/api/validations/evals";
import { cn } from "@onecli/ui/lib/utils";

/**
 * A custom check's verdict: the judge's summary, then each criterion it
 * checked, met or not, with its note. When the judge could not run, why.
 *
 * SECURITY: everything here is model text, rendered as text.
 */
export const ResultJudgement = ({
  result,
}: {
  result: Pick<EvalResultView, "outcome" | "judgement" | "judgeError">;
}) => {
  const { judgement, judgeError, outcome } = result;
  if (outcome === "pending" || outcome === "error") return null;
  if (!judgement)
    return (
      <div className="bg-muted/40 rounded-md p-3 text-xs">
        <p className="text-muted-foreground font-medium">Judge</p>
        <p className="mt-1">
          The answer could not be judged
          {judgeError ? `: ${judgeError}` : "."}
        </p>
      </div>
    );
  const met = judgement.criteria.filter((c) => c.met).length;
  return (
    <div className="bg-muted/40 space-y-2 rounded-md p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
        <p className="text-muted-foreground font-medium">
          Judge{" "}
          <span
            className={cn(
              "font-semibold",
              judgement.passed
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-destructive",
            )}
          >
            {judgement.passed ? "passed it" : "failed it"}
          </span>
          {judgement.criteria.length > 0 && (
            <span className="font-normal">
              {" "}
              · {met} of {judgement.criteria.length} criteria met
            </span>
          )}
        </p>
        <p className="text-muted-foreground">{judgement.model}</p>
      </div>
      <p className="break-words whitespace-pre-wrap">{judgement.summary}</p>
      {judgement.criteria.length > 0 && (
        <ul className="space-y-1.5" aria-label="Criteria">
          {judgement.criteria.map((criterion, index) => (
            <li key={index} className="flex items-start gap-2 text-xs">
              {criterion.met ? (
                <Check
                  className="mt-0.5 size-3.5 shrink-0 text-emerald-700 dark:text-emerald-400"
                  aria-hidden
                />
              ) : (
                <X
                  className="text-destructive mt-0.5 size-3.5 shrink-0"
                  aria-hidden
                />
              )}
              <div className="min-w-0 space-y-0.5">
                <p className="break-words">
                  <span className="sr-only">
                    {criterion.met ? "Met: " : "Not met: "}
                  </span>
                  {criterion.criterion}
                </p>
                {criterion.note && (
                  <p className="text-muted-foreground break-words">
                    {criterion.note}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
