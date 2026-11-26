import { Check, CircleHelp, X } from "lucide-react";
import type { EvalResultView } from "@onecli/api/validations/evals";

/**
 * The apps a question required and whether each was reached. App evidence
 * is approximate (gateway activity in the run's time window); when it was
 * unavailable, nothing is called missing.
 */
export const ResultAppChecks = ({
  result,
  appLabel,
}: {
  result: Pick<EvalResultView, "expectedApps" | "missingApps" | "outcome">;
  appLabel: (id: string) => string;
}) => {
  if (result.expectedApps.length === 0) return null;
  const checked = result.missingApps !== null;
  const missing = new Set(result.missingApps);
  return (
    <div className="min-w-0 space-y-1 text-xs">
      <p className="text-muted-foreground font-medium">
        Apps{" "}
        <span className="font-normal">
          {result.outcome === "pending"
            ? "(not checked yet)"
            : checked
              ? "(approximate)"
              : "(could not be checked)"}
        </span>
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {result.expectedApps.map((app) => {
          const label = appLabel(app);
          const state = !checked
            ? "unknown"
            : missing.has(app)
              ? "missing"
              : "used";
          return (
            <li
              key={app}
              className="bg-muted inline-flex max-w-full items-center gap-1 rounded-md px-2 py-1"
            >
              {state === "used" ? (
                <Check
                  className="size-3 shrink-0 text-emerald-700 dark:text-emerald-400"
                  aria-hidden
                />
              ) : state === "missing" ? (
                <X className="text-destructive size-3 shrink-0" aria-hidden />
              ) : (
                <CircleHelp
                  className="text-muted-foreground size-3 shrink-0"
                  aria-hidden
                />
              )}
              <span className="truncate">{label}</span>
              <span className="sr-only">
                {state === "used"
                  ? "reached"
                  : state === "missing"
                    ? "not reached"
                    : "not checked"}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
