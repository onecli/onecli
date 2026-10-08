import { describe, expect, it } from "vitest";
import {
  EVAL_APPS_MAX,
  EVAL_TEXT_MAX_LENGTH,
  NUMERIC_EXPECTED_MESSAGE,
} from "@onecli/api/validations/evals";
import { validateQuestion, type QuestionDraft } from "./question-validation";

const draft = (patch: Partial<QuestionDraft> = {}): QuestionDraft => ({
  question: "How many customers do we have?",
  expected: "Acme renewal",
  kind: "text",
  expectedApps: [],
  ...patch,
});

describe("validateQuestion", () => {
  it("returns the trimmed body the API stores, with apps normalized", () => {
    expect(
      validateQuestion(
        draft({
          question: "  What was Q1 revenue?  ",
          expected: " $3.2M ",
          kind: "numeric",
          expectedApps: [" Gmail ", "gmail", "host:crm.example.com"],
        }),
      ),
    ).toEqual({
      ok: true,
      body: {
        question: "What was Q1 revenue?",
        expected: "$3.2M",
        kind: "numeric",
        expectedApps: ["gmail", "host:crm.example.com"],
      },
    });
  });

  it("names every invalid field and focuses the first in form order", () => {
    const result = validateQuestion(
      draft({ question: "   ", expected: "", kind: "text" }),
    );
    expect(result).toEqual({
      ok: false,
      errors: {
        question: "Enter a question for your agent.",
        expected: "Enter the expected answer.",
      },
      first: "question",
    });
  });

  it("refuses an expected answer that is not one number, with the API's message", () => {
    expect(
      validateQuestion(
        draft({ kind: "numeric", expected: "about 3 million in 2024" }),
      ),
    ).toEqual({
      ok: false,
      errors: { expected: NUMERIC_EXPECTED_MESSAGE },
      first: "expected",
    });
  });

  it("enforces the API's length and app-count limits", () => {
    const tooLong = validateQuestion(
      draft({ question: "q".repeat(EVAL_TEXT_MAX_LENGTH + 1) }),
    );
    expect(tooLong).toMatchObject({
      ok: false,
      errors: { question: expect.stringMatching(/4,000/) },
    });

    const tooMany = validateQuestion(
      draft({
        expectedApps: Array.from(
          { length: EVAL_APPS_MAX + 1 },
          (_, i) => `app-${i}`,
        ),
      }),
    );
    expect(tooMany).toMatchObject({ ok: false, first: "expectedApps" });
  });
});
