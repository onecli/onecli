"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import {
  isActiveEvalRun,
  type EvalOutcome,
  type EvalResultView,
} from "@onecli/api/validations/evals";
import { Card } from "@onecli/ui/components/card";
import { Button } from "@onecli/ui/components/button";
import { useEvalRun } from "@/hooks/use-evals";
import { plural } from "./eval-copy";
import { ResultCard } from "./result-card";
import { RunFingerprint } from "./run-fingerprint";
import { RunStatusHeader } from "./run-status-header";

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
  // What the person opened by hand; every result starts closed.
  const [touched, setTouched] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  // Clicking a count shows only that outcome; empty = everything.
  const [filter, setFilter] = useState<ReadonlySet<EvalOutcome>>(
    () => new Set(),
  );
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
  // Run order, the same numbers the reports use: 1, 2, 3…
  const numberOf = new Map(detail.results.map((r, i) => [r.questionId, i + 1]));
  const isOpen = (r: EvalResultView) => touched.get(r.questionId) ?? false;
  // Only filters with something to show apply: a count that dropped to 0
  // (`pending` once the run finishes) hides its chip, so it must not leave
  // an empty list nobody can clear.
  const shown = new Set(
    [...filter].filter((outcome) => detail.counts[outcome] > 0),
  );
  const list =
    shown.size === 0
      ? detail.results
      : detail.results.filter((r) => shown.has(r.outcome));
  const allOpen = list.length > 0 && list.every(isOpen);
  const setOpen = (ids: string[], open: boolean) =>
    setTouched((current) => {
      const next = new Map(current);
      for (const id of ids) next.set(id, open);
      return next;
    });
  return (
    <Card className="gap-0 overflow-hidden p-0">
      <RunStatusHeader
        run={detail}
        filter={shown}
        onToggleFilter={(outcome) => {
          const next = new Set(shown);
          if (next.has(outcome)) next.delete(outcome);
          else next.add(outcome);
          setFilter(next);
        }}
        action={
          list.length > 1 && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                setOpen(
                  list.map((r) => r.questionId),
                  !allOpen,
                )
              }
            >
              {allOpen ? "Collapse all" : "Expand all"}
            </Button>
          )
        }
      />
      <ul aria-label="Results" className="divide-y">
        {list.map((result) => (
          <ResultCard
            key={result.questionId}
            result={result}
            number={numberOf.get(result.questionId) ?? 0}
            open={isOpen(result)}
            onOpenChange={(open) => setOpen([result.questionId], open)}
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
