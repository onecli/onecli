import { z } from "zod";
import { callLlm, postToProvider, type LlmCallKey } from "../llm-direct-call";

/**
 * Short server-side inference on the agent's OWN granted LLM key: the model
 * door of every LLM judge (`classify.ts` is its only caller). Nothing here
 * may delay or fail the work a judge sits in front of, so every call is
 * bounded by the caller's `AbortSignal` and every failure is the caller's to
 * degrade. The key (`resolveLlmCallKey`) and the wire shape of each key kind
 * are `llm-direct-call.ts`'s.
 */

/**
 * Fast models owned by these calls, deliberately not the agent's own model:
 * an opus-class call would blow every deadline here.
 *
 * Haiku 5.5 thinks adaptively by default, which spent the whole few-token
 * budget on a thinking block (live, 2026-10-13); Anthropic documents
 * `thinking: {type: "disabled"}` as accepted at `high` effort and below, so
 * a one-word answer runs with thinking off at `low`. gpt-6-luna is OpenAI's
 * named replacement for gpt-4o-mini (shut down 2027-01-14); it is a
 * reasoning model, so it runs at `reasoning_effort: "none"` and caps output
 * with `max_completion_tokens` (`max_tokens` is deprecated for it).
 */
const FAST_MODEL: Record<LlmCallKey["provider"], string> = {
  anthropic: "claude-haiku-5-5",
  openai: "gpt-6-luna",
};

export interface FastAsk {
  prompt: string;
  maxTokens: number;
  signal: AbortSignal;
}

/**
 * One short completion, thinking off. Throws on a refused, declined or
 * aborted call; callers own their fallback.
 */
export const askFastModel = async (
  key: LlmCallKey,
  ask: FastAsk,
): Promise<string> => {
  const result = await callLlm(key, {
    model: FAST_MODEL[key.provider],
    prompt: ask.prompt,
    maxTokens: ask.maxTokens,
    thinking: "off",
    signal: ask.signal,
  });
  // A safety-classifier decline is a 200 with no usable content; there is no
  // server-side fallback model, so it is a refusal like any other.
  if (result.stopReason === "refusal")
    throw new Error(`${key.provider} refusal`);
  return result.text;
};

/** One Decisions-API `choice` question: a fixed set of values, each with a
 * description of when it applies. */
export interface ChoiceQuestion {
  name: string;
  instructions: string;
  choices: { value: string; description: string }[];
}

/** A choice question's answer: the picked value and the model's confidence. */
export interface ChoiceAnswer {
  choice: string;
  confidence: number;
}

/** The only model OpenAI documents for `/v1/decisions` (public beta). */
const DECISIONS_MODEL = "gpt-6-luna";

const decisionsResponse = z.object({
  answers: z.array(
    z.object({
      type: z.string(),
      name: z.string().optional(),
      choice: z.unknown().optional(),
      confidence: z.number().optional(),
    }),
  ),
});

/**
 * Typed answers from OpenAI's Decisions API (`POST /v1/decisions`): one
 * value per `choice` question, with a confidence, in one call. A question
 * the model refused (`type: "refusal"`) is simply absent from the map.
 * Throws on a refused or aborted call, like `askFastModel`.
 */
export const askDecisions = async (
  key: Extract<LlmCallKey, { provider: "openai" }>,
  input: { input: string; questions: ChoiceQuestion[]; signal: AbortSignal },
): Promise<Map<string, ChoiceAnswer>> => {
  const parsed = await postToProvider(
    key,
    "/v1/decisions",
    {
      model: DECISIONS_MODEL,
      input: input.input,
      questions: input.questions.map((q) => ({ type: "choice", ...q })),
    },
    decisionsResponse,
    input.signal,
  );
  const answers = new Map<string, ChoiceAnswer>();
  for (const answer of parsed.answers) {
    if (
      answer.type === "choice" &&
      answer.name &&
      typeof answer.choice === "string"
    ) {
      answers.set(answer.name, {
        choice: answer.choice,
        confidence: answer.confidence ?? 0,
      });
    }
  }
  return answers;
};
