"use client";

import { Pencil, ScrollText } from "lucide-react";
import type { EvalResultView } from "@onecli/api/validations/evals";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import { CHECK_LABEL, OUTCOME_LABEL } from "./eval-copy";
import { ExpandableText } from "./expandable-text";
import { OUTCOME_TONE, OutcomeIcon } from "./outcome-icon";
import { ResultAppChecks } from "./result-app-checks";
import { ResultChange } from "./result-change";

/**
 * One question's result as a card: the question and its outcome, then what
 * was expected next to what the agent answered (stacked on narrow screens),
 * then the app checks, and the actions to inspect the run or edit the test.
 *
 * SECURITY: the answer and error are untrusted model text, rendered as text.
 */
export const ResultCard = ({
  result,
  appLabel,
  onInspect,
  onEdit,
}: {
  result: EvalResultView;
  appLabel: (id: string) => string;
  onInspect: (turnId: string) => void;
  /** Absent when the question has been archived since the run. */
  onEdit?: () => void;
}) => {
  const { outcome, turnId } = result;
  return (
    <li className="space-y-3 p-4">
      <div className="flex items-start gap-2.5">
        <OutcomeIcon outcome={outcome} className="mt-0.5" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium break-words">{result.question}</p>
          <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className={cn("font-medium", OUTCOME_TONE[outcome])}>
              {OUTCOME_LABEL[outcome]}
            </span>
            <span aria-hidden>·</span>
            <span>{CHECK_LABEL[result.kind]}</span>
            <ResultChange change={result.change} />
          </p>
        </div>
      </div>

      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div className="bg-muted/40 min-w-0 rounded-md p-3">
          <dt className="text-muted-foreground text-xs font-medium">
            Expected
          </dt>
          <dd className="mt-1 break-words whitespace-pre-wrap">
            {result.expected}
          </dd>
        </div>
        <div className="bg-muted/40 min-w-0 rounded-md p-3">
          <dt className="text-muted-foreground text-xs font-medium">Answer</dt>
          <dd className="mt-1">
            {result.answer === null ? (
              <span className="text-muted-foreground">
                {outcome === "pending"
                  ? "Waiting for the answer…"
                  : "No answer"}
              </span>
            ) : (
              <ExpandableText text={result.answer} />
            )}
            {result.error && (
              <p className="text-destructive mt-2 text-xs break-words">
                {result.error}
              </p>
            )}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-end justify-between gap-2">
        <ResultAppChecks result={result} appLabel={appLabel} />
        <div className="ms-auto flex gap-1">
          {onEdit && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onEdit}
              aria-label={`Edit test question: ${result.question}`}
            >
              <Pencil />
              Edit
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={!turnId}
            onClick={() => turnId && onInspect(turnId)}
            aria-label={`Inspect run: ${result.question}`}
          >
            <ScrollText />
            Inspect run
          </Button>
        </div>
      </div>
    </li>
  );
};
