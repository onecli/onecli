"use client";

import { useState } from "react";
import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";
import { isActiveEvalRun } from "@onecli/api/validations/evals";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { useEvals, useStartEvalRun } from "@/hooks/use-evals";
import { RunDetailSheet } from "@/lib/agents/runs";
import type { EvalQuestion } from "@/lib/api";
import { useAgentPageAgent } from "../../_components/agent-page-frame";
import { ArchiveQuestionDialog } from "./archive-question-dialog";
import { ChecksHelp } from "./checks-help";
import { plural } from "./eval-copy";
import { QuestionDialog, type QuestionDialogState } from "./question-dialog";
import { QuestionList } from "./question-list";
import { RunPicker } from "./run-picker";
import { RunResults } from "./run-results";
import { useAgentEvalApps } from "./use-agent-eval-apps";

/**
 * The agent's Evals: test questions with known answers, asked of the live
 * agent after a change. Results lead (latest run first, any earlier run one
 * pick away); the questions fold below them.
 */
export const EvalsSection = () => {
  const agent = useAgentPageAgent();
  const view = useEvals(agent.id);
  const start = useStartEvalRun(agent.id);
  const [pickedRunId, setPickedRunId] = useState<string | null>(null);
  const [questionsOpen, setQuestionsOpen] = useState<boolean | null>(null);
  const [dialog, setDialog] = useState<QuestionDialogState>({
    open: false,
    editing: null,
    key: 0,
  });
  const [archiving, setArchiving] = useState<EvalQuestion | null>(null);
  const [inspecting, setInspecting] = useState<string | null>(null);
  // Labels for stored apps; the agent's apps load once there are questions.
  const apps = useAgentEvalApps(
    agent.id,
    (view.data?.questions.length ?? 0) > 0,
  );

  if (view.isPending)
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
        <span className="sr-only">Loading evals</span>
      </div>
    );
  if (view.isError)
    return (
      <div
        role="alert"
        className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border p-4 text-sm"
      >
        Evals failed to load. Refresh to try again.
      </div>
    );

  const { questions, runs, maxQuestions } = view.data;
  const latest = runs[0];
  const runId =
    runs.find((run) => run.id === pickedRunId)?.id ?? latest?.id ?? null;
  const running = latest !== undefined && isActiveEvalRun(latest.status);
  const busy = start.isPending || running;
  const questionIds = new Set(questions.map((q) => q.id));

  const openDialog = (editing: EvalQuestion | null) =>
    setDialog((current) => ({ open: true, editing, key: current.key + 1 }));

  const runTests = () =>
    start.mutate(undefined, {
      onSuccess: (run) => {
        setPickedRunId(run.id);
        toast.success(
          `Asking ${plural(run.total, "test question", "test questions")}`,
        );
      },
      onError: (error) => toast.error(error.message),
    });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Evals</h2>
          <p className="text-muted-foreground text-sm">
            Ask your agent questions you know the answers to, and see what
            changed after you edit it.
          </p>
        </div>
        <Button
          size="sm"
          disabled={questions.length === 0}
          loading={busy}
          onClick={runTests}
        >
          {!busy && <Play />}
          {busy ? "Running tests…" : "Run tests"}
        </Button>
      </div>

      <section aria-labelledby="eval-results-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="eval-results-heading" className="text-sm font-medium">
            Results
          </h3>
          {runId && runs.length > 1 && (
            <RunPicker
              runs={runs}
              value={runId}
              onValueChange={setPickedRunId}
            />
          )}
        </div>
        {runId ? (
          <RunResults
            agentId={agent.id}
            runId={runId}
            appLabel={apps.appLabel}
            editableQuestionIds={questionIds}
            onInspect={setInspecting}
            onEdit={(questionId) =>
              openDialog(questions.find((q) => q.id === questionId) ?? null)
            }
          />
        ) : (
          <Card className="gap-1 p-4">
            <p className="text-sm font-medium">No results yet</p>
            <p className="text-muted-foreground text-sm">
              {questions.length === 0
                ? "Add a test question below, then run your tests."
                : "Run your tests to see how your agent answers."}
            </p>
          </Card>
        )}
      </section>

      <div className="border-t pt-4">
        <QuestionList
          questions={questions}
          maxQuestions={maxQuestions}
          open={questionsOpen ?? runs.length === 0}
          onOpenChange={setQuestionsOpen}
          appLabel={apps.appLabel}
          onAdd={() => openDialog(null)}
          onEdit={openDialog}
          onArchive={setArchiving}
        />
      </div>

      <ChecksHelp />

      <QuestionDialog
        agentId={agent.id}
        state={dialog}
        onClose={() => setDialog((current) => ({ ...current, open: false }))}
      />
      <ArchiveQuestionDialog
        agentId={agent.id}
        question={archiving}
        onClose={() => setArchiving(null)}
      />
      <RunDetailSheet
        agentId={agent.id}
        turnId={inspecting}
        onOpenChange={(open) => {
          if (!open) setInspecting(null);
        }}
      />
    </div>
  );
};
