"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { DialogBody, DialogFooter } from "@onecli/ui/components/dialog";
import { Input } from "@onecli/ui/components/input";
import { Textarea } from "@onecli/ui/components/textarea";
import {
  EVAL_CRITERIA_MAX_LENGTH,
  EVAL_TEXT_MAX_LENGTH,
  type EvalCheckKind,
} from "@onecli/api/validations/evals";
import type { useSaveEvalQuestion } from "@/hooks/use-evals";
import type { EvalQuestion } from "@/lib/api";
import { CheckKindPicker } from "./check-kind-picker";
import { CRITERIA_TEMPLATE, EXAMPLE_QUESTION } from "./eval-copy";
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

/** The expected field, per check: what it holds and how it is read. */
const EXPECTED_FIELD: Record<
  EvalCheckKind,
  { label: string; help: string; placeholder: string; max: number }
> = {
  numeric: {
    label: "Expected number",
    help: "One number, like 3200000 or $3.2M. Not a sentence or a date.",
    placeholder: "e.g. 3200000",
    max: EVAL_TEXT_MAX_LENGTH,
  },
  text: {
    label: "Expected keywords",
    help: "Distinctive words. Common words like “the” are ignored, and meaning or negation is not understood.",
    placeholder: "e.g. Acme renewal",
    max: EVAL_TEXT_MAX_LENGTH,
  },
  custom: {
    label: "Success criteria",
    help: "Plain words for the judge: the facts a good answer covers, and the pass rule (for example “at least 70% of the facts” or “any invented fact fails”). With no pass rule, every fact must be there. Wording may differ; the substance must match.",
    placeholder: CRITERIA_TEMPLATE,
    max: EVAL_CRITERIA_MAX_LENGTH,
  },
};

const draftFrom = (question: EvalQuestion | null): QuestionDraft => ({
  question: question?.question ?? "",
  expected: question?.expected ?? "",
  kind: question?.kind ?? "text",
  expectedApps: question?.expectedApps ?? [],
});

/** Whether the draft still holds its check's example, untouched. */
const isExample = (draft: QuestionDraft) =>
  draft.question === EXAMPLE_QUESTION[draft.kind].question &&
  draft.expected === EXAMPLE_QUESTION[draft.kind].expected;

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

  /** Fill the selected check's example; offered only on an empty draft. */
  const fillExample = () => {
    update(EXAMPLE_QUESTION[draft.kind], "question");
    setErrors((current) => ({ ...current, expected: undefined }));
    document.getElementById(FIELD_ID.question)?.focus();
  };
  const blank = !draft.question.trim() && !draft.expected.trim();

  /** Switching checks swaps an untouched example for the new check's one.
   * Never in edit: a saved question is the author's, even when it matches. */
  const changeKind = (kind: EvalCheckKind) =>
    update(
      !editing && isExample(draft)
        ? { kind, ...EXAMPLE_QUESTION[kind] }
        : { kind },
      "expected",
    );

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
  const custom = draft.kind === "custom";
  const expectedField = EXPECTED_FIELD[draft.kind];
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
            help={
              <>
                Asked to the agent exactly as written.
                {!editing && blank && (
                  <>
                    {" Or "}
                    <button
                      type="button"
                      onClick={fillExample}
                      className="text-foreground focus-visible:ring-ring/50 rounded-sm underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-[3px]"
                    >
                      try an example
                    </button>
                    .
                  </>
                )}
              </>
            }
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
              onValueChange={changeKind}
            />
          </div>

          <FormField
            id={FIELD_ID.expected}
            label={expectedField.label}
            help={expectedField.help}
            error={errors.expected}
          >
            <ExpectedControl
              {...control("expected")}
              {...(!numeric && { rows: custom ? 8 : 2 })}
              value={draft.expected}
              maxLength={expectedField.max}
              onChange={(event) =>
                update({ expected: event.target.value }, "expected")
              }
              placeholder={expectedField.placeholder}
            />
            {custom && draft.expected.trim() === "" && (
              <Button
                type="button"
                size="xs"
                variant="link"
                className="h-auto px-0"
                onClick={() =>
                  update({ expected: CRITERIA_TEMPLATE }, "expected")
                }
              >
                Start from the example
              </Button>
            )}
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
