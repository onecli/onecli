"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { DialogBody, DialogFooter } from "@onecli/ui/components/dialog";
import { Input } from "@onecli/ui/components/input";
import { Textarea } from "@onecli/ui/components/textarea";
import { EVAL_TEXT_MAX_LENGTH } from "@onecli/api/validations/evals";
import type { useSaveEvalQuestion } from "@/hooks/use-evals";
import type { EvalQuestion } from "@/lib/api";
import { CheckKindPicker } from "./check-kind-picker";
import { ExpectedAppsField } from "./expected-apps-field";
import { fieldDescribedBy, FormField } from "./form-field";
import {
  validateQuestion,
  type QuestionDraft,
  type QuestionErrors,
  type QuestionField,
} from "./question-validation";
import type { AgentEvalApps } from "./use-agent-eval-apps";

const FIELD_ID: Record<QuestionField, string> = {
  question: "eval-question",
  expected: "eval-expected",
  expectedApps: "eval-apps",
};
const CHECK_LABEL_ID = "eval-check-label";

const draftFrom = (question: EvalQuestion | null): QuestionDraft => ({
  question: question?.question ?? "",
  expected: question?.expected ?? "",
  kind: question?.kind ?? "text",
  expectedApps: question?.expectedApps ?? [],
});

/**
 * The add/edit form for one test question. The dialog keys it per open, so
 * its state always starts from the question being edited, with no reset
 * effect. Validation runs the API's own schema on submit; an edited field's
 * error clears as soon as it changes.
 */
export const QuestionForm = ({
  editing,
  save,
  apps,
  onDone,
}: {
  editing: EvalQuestion | null;
  /** Owned by the dialog, which must know when a save is in flight. */
  save: ReturnType<typeof useSaveEvalQuestion>;
  apps: AgentEvalApps;
  onDone: () => void;
}) => {
  const [draft, setDraft] = useState(() => draftFrom(editing));
  const [errors, setErrors] = useState<QuestionErrors>({});
  const update = (patch: Partial<QuestionDraft>, clears: QuestionField) => {
    setDraft((current) => ({ ...current, ...patch }));
    setErrors((current) => ({ ...current, [clears]: undefined }));
  };

  const submit = () => {
    const checked = validateQuestion(draft);
    if (!checked.ok) {
      setErrors(checked.errors);
      document.getElementById(FIELD_ID[checked.first])?.focus();
      return;
    }
    save.mutate(
      { id: editing?.id ?? null, input: checked.body },
      {
        onSuccess: () => {
          toast.success(
            editing ? "Test question saved" : "Test question added",
          );
          onDone();
        },
      },
    );
  };

  const numeric = draft.kind === "numeric";
  const ExpectedControl = numeric ? Input : Textarea;
  const control = (field: QuestionField) => ({
    id: FIELD_ID[field],
    "aria-invalid": !!errors[field],
    "aria-describedby": fieldDescribedBy(FIELD_ID[field], errors[field]),
  });

  return (
    <form
      noValidate
      aria-busy={save.isPending}
      className="flex min-h-0 flex-1 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!save.isPending) submit();
      }}
    >
      <DialogBody className="-mx-1 px-1">
        <fieldset disabled={save.isPending} className="space-y-5">
          <FormField
            id={FIELD_ID.question}
            label="Question"
            help="Asked to the agent exactly as written."
            error={errors.question}
          >
            <Textarea
              {...control("question")}
              rows={3}
              value={draft.question}
              maxLength={EVAL_TEXT_MAX_LENGTH}
              onChange={(event) =>
                update({ question: event.target.value }, "question")
              }
              placeholder="e.g. What was our revenue in Q1?"
            />
          </FormField>

          <div className="space-y-2">
            <p id={CHECK_LABEL_ID} className="text-sm font-medium">
              Check the answer with
            </p>
            <CheckKindPicker
              labelledBy={CHECK_LABEL_ID}
              value={draft.kind}
              onValueChange={(kind) => update({ kind }, "expected")}
            />
          </div>

          <FormField
            id={FIELD_ID.expected}
            label={numeric ? "Expected number" : "Expected keywords"}
            help={
              numeric
                ? "One number, like 3200000 or $3.2M. Not a sentence or a date."
                : "Distinctive words. Common words like “the” are ignored, and meaning or negation is not understood."
            }
            error={errors.expected}
          >
            <ExpectedControl
              {...control("expected")}
              {...(!numeric && { rows: 2 })}
              value={draft.expected}
              maxLength={EVAL_TEXT_MAX_LENGTH}
              onChange={(event) =>
                update({ expected: event.target.value }, "expected")
              }
              placeholder={numeric ? "e.g. 3200000" : "e.g. Acme renewal"}
            />
          </FormField>

          <FormField
            id={FIELD_ID.expectedApps}
            label="Apps it should use"
            help="Optional. The test also checks that the agent reached these apps, judged from gateway activity during the run."
            error={errors.expectedApps}
          >
            <ExpectedAppsField
              id={FIELD_ID.expectedApps}
              describedBy={fieldDescribedBy(
                FIELD_ID.expectedApps,
                errors.expectedApps,
              )}
              invalid={!!errors.expectedApps}
              value={draft.expectedApps}
              onChange={(expectedApps) =>
                update({ expectedApps }, "expectedApps")
              }
              options={apps.options}
              appLabel={apps.appLabel}
              state={apps.state}
              onRetry={apps.retry}
              disabled={save.isPending}
            />
          </FormField>
        </fieldset>
        {save.isError && (
          <p role="alert" className="text-destructive mt-4 text-sm">
            {save.error.message}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={save.isPending}
          onClick={onDone}
        >
          Cancel
        </Button>
        <Button type="submit" loading={save.isPending}>
          {save.isPending
            ? "Saving…"
            : editing
              ? "Save question"
              : "Add question"}
        </Button>
      </DialogFooter>
    </form>
  );
};
