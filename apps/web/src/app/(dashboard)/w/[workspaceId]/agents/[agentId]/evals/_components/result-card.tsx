"use client";

import { ChevronRight, Pencil, ScrollText } from "lucide-react";
import type { EvalResultView } from "@onecli/api/validations/evals";
import { Button } from "@onecli/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@onecli/ui/components/collapsible";
import { cn } from "@onecli/ui/lib/utils";
import { CHECK_LABEL, OUTCOME_LABEL } from "./eval-copy";
import { ExpandableText } from "./expandable-text";
import { OUTCOME_TONE, OutcomeIcon } from "./outcome-icon";
import { ResultAppChecks } from "./result-app-checks";
import { ResultChange } from "./result-change";
import { ResultJudgement } from "./result-judgement";

/**
 * One question's result as a row that opens: the header (its number in the
 * run, the question, the outcome, the check, how it moved, and a custom
 * check's criteria count) always shows, so a closed list still reads as a
 * full report. Open, it shows what was expected next to what the agent
 * answered, the judge's verdict, the app checks, and the actions.
 *
 * SECURITY: the answer, the error and the judge's verdict are untrusted
 * model text, rendered as text.
 */
export const ResultCard = ({
  result,
  number,
  open,
  onOpenChange,
  appLabel,
  onInspect,
  onEdit,
}: {
  result: EvalResultView;
  /** The question's place in the run (1-based), as the reports number it. */
  number: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appLabel: (id: string) => string;
  onInspect: (turnId: string) => void;
  /** Absent when the question has been archived since the run. */
  onEdit?: () => void;
}) => {
  const { outcome, turnId, judgement } = result;
  const met = judgement?.criteria.filter((c) => c.met).length ?? 0;
  const ofCriteria = judgement?.criteria.length ?? 0;
  return (
    <li>
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <CollapsibleTrigger
          className="hover:bg-muted/40 focus-visible:ring-ring/50 flex w-full items-start gap-2.5 px-4 py-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset"
          aria-label={`${open ? "Hide" : "Show"} result ${number}, ${OUTCOME_LABEL[outcome]}: ${result.question}`}
        >
          <ChevronRight
            className={cn(
              "text-muted-foreground mt-0.5 size-4 shrink-0 transition-transform",
              open && "rotate-90",
            )}
            aria-hidden
          />
          <span className="text-muted-foreground mt-px w-5 shrink-0 text-sm tabular-nums">
            {number}.
          </span>
          <OutcomeIcon outcome={outcome} className="mt-0.5" />
          <span className="min-w-0 flex-1 space-y-1">
            <span
              className={cn(
                "block font-medium break-words",
                !open && "line-clamp-1",
              )}
            >
              {result.question}
            </span>
            <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span className={cn("font-medium", OUTCOME_TONE[outcome])}>
                {OUTCOME_LABEL[outcome]}
              </span>
              <span aria-hidden>·</span>
              <span>{CHECK_LABEL[result.kind]}</span>
              {ofCriteria > 0 && (
                <>
                  <span aria-hidden>·</span>
                  <span>
                    {met} of {ofCriteria} criteria met
                  </span>
                </>
              )}
              <ResultChange change={result.change} />
            </span>
          </span>
        </CollapsibleTrigger>

        <CollapsibleContent className="space-y-3 px-4 pb-4 sm:ps-[4.25rem]">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="bg-muted/40 min-w-0 rounded-md p-3">
              <dt className="text-muted-foreground text-xs font-medium">
                {result.kind === "custom" ? "Success criteria" : "Expected"}
              </dt>
              <dd className="mt-1">
                <ExpandableText text={result.expected} />
              </dd>
            </div>
            <div className="bg-muted/40 min-w-0 rounded-md p-3">
              <dt className="text-muted-foreground text-xs font-medium">
                Answer
              </dt>
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

          {result.kind === "custom" && <ResultJudgement result={result} />}

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
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
};
