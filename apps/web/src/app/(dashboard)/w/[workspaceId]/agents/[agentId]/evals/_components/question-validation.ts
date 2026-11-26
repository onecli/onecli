import {
  evalQuestionSchema,
  type EvalCheckKind,
  type EvalQuestionBody,
} from "@onecli/api/validations/evals";

/** The question form's fields, as typed. */
export interface QuestionDraft {
  question: string;
  expected: string;
  kind: EvalCheckKind;
  expectedApps: string[];
}

export type QuestionField = "question" | "expected" | "expectedApps";
export type QuestionErrors = Partial<Record<QuestionField, string>>;

const FIELDS: readonly QuestionField[] = [
  "question",
  "expected",
  "expectedApps",
];
const isField = (key: unknown): key is QuestionField =>
  FIELDS.some((field) => field === key);

/**
 * Validate a draft with the API's own schema: the same limits and the same
 * number rule, so the form never accepts what the server would refuse. The
 * first message per field is kept, in field order.
 */
export const validateQuestion = (
  draft: QuestionDraft,
):
  | { ok: true; body: EvalQuestionBody }
  | { ok: false; errors: QuestionErrors; first: QuestionField } => {
  const parsed = evalQuestionSchema.safeParse(draft);
  if (parsed.success) return { ok: true, body: parsed.data };
  const errors: QuestionErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (isField(field) && !errors[field]) errors[field] = issue.message;
  }
  const first = FIELDS.find((field) => errors[field]) ?? "question";
  return { ok: false, errors, first };
};
