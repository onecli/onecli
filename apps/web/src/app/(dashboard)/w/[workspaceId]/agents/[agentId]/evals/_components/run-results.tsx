"use client";

import { Loader2 } from "lucide-react";
import {
  isActiveEvalRun,
  type EvalOutcome,
  type EvalResultView,
} from "@onecli/api/validations/evals";
import { Card } from "@onecli/ui/components/card";
import { useEvalRun } from "@/hooks/use-evals";
import { plural } from "./eval-copy";
import { ResultCard } from "./result-card";
import { RunFingerprint } from "./run-fingerprint";
import { RunStatusHeader } from "./run-status-header";

/** Problems first, so the list reads as a to-do: what broke, then what
 * could not be checked, then what is still running, then what passed. */
const ORDER: Record<EvalOutcome, number> = {
  mismatch: 0,
  error: 1,
  inconclusive: 2,
  pending: 3,
  passed: 4,
};

const sorted = (results: EvalResultView[]) =>
  [...results].sort((a, b) => {
    const regressed =
      Number(b.change === "regressed") - Number(a.change === "regressed");
    return regressed || ORDER[a.outcome] - ORDER[b.outcome];
  });

/** One run's results, polled while it is active. */
export const RunResults = ({
  agentId,
  runId,
  appLabel,
  editableQuestionIds,
  onInspect,
  onEdit,
}: {
  agentId: string;
  runId: string;
  appLabel: (id: string) => string;
  /** The agent's current (not archived) questions: only these can be
   * edited from a result. */
  editableQuestionIds: ReadonlySet<string>;
  onInspect: (turnId: string) => void;
  onEdit: (questionId: string) => void;
}) => {
  const run = useEvalRun(agentId, runId);
  if (run.isError)
    return (
      <Card role="alert" className="text-destructive p-4 text-sm">
        This run could not be loaded.
      </Card>
    );
  if (!run.data)
    return (
      <Card className="flex justify-center p-8">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
        <span className="sr-only">Loading results</span>
      </Card>
    );

  const detail = run.data;
  const waiting = detail.total - detail.results.length;
  return (
    <Card className="gap-0 overflow-hidden p-0">
      <RunStatusHeader run={detail} />
      <ul aria-label="Results" className="divide-y">
        {sorted(detail.results).map((result) => (
          <ResultCard
            key={result.questionId}
            result={result}
            appLabel={appLabel}
            onInspect={onInspect}
            onEdit={
              editableQuestionIds.has(result.questionId)
                ? () => onEdit(result.questionId)
                : undefined
            }
          />
        ))}
      </ul>
      {waiting > 0 && isActiveEvalRun(detail.status) && (
        <p className="text-muted-foreground border-t px-4 py-3 text-sm">
          {plural(waiting, "more question", "more questions")} waiting
        </p>
      )}
      <RunFingerprint run={detail} />
    </Card>
  );
};
