import { askDecisions, askFastModel, type ChoiceQuestion } from "./fast-model";
import type { LlmCallKey } from "../llm-direct-call";

/**
 * THE CLASSIFIER every LLM judge is built on: a judge declares typed
 * QUESTIONS (each a closed set of choices with what each means), and
 * `classify` gets one answer per question from the agent's fast model, on
 * the best path its key has:
 *
 * - an OpenAI key asks the Decisions API (typed answers, nothing to parse),
 *   and falls through to the prompt path when that beta endpoint refuses or
 *   is slow, so a judge never goes dark because Decisions did;
 * - every key can ask a plain PROMPT: the questions rendered as labeled
 *   choice lists, and an answer block of `name: CHOICE` lines read back.
 *
 * What it guarantees, so no judge re-implements it:
 * - answers are ONLY declared choices (case- and punctuation-insensitive);
 *   anything else is absent, never guessed;
 * - an answer is read from the LAST `name:` line, so a model that reasons
 *   first can mention a choice in its reasoning without it counting;
 * - the return type is derived from the question set: a judge reads
 *   `answers.who` as `"agent" | "room" | ...`, never a raw string.
 *
 * It throws only when NOTHING was answered (refusal, abort, unreadable);
 * partial answers come back partial, and the judge decides what a missing
 * one means.
 */

/** One allowed answer and when it applies (the model reads `description`). */
export interface Choice<V extends string = string> {
  value: V;
  description: string;
}

/** One question with a closed set of answers. */
export interface Question<
  N extends string = string,
  V extends string = string,
> {
  /** The answer's key; a short identifier (`who`, `verdict`). */
  name: N;
  /** What to decide, in one or two sentences. */
  instructions: string;
  choices: readonly Choice<V>[];
}

/** The typed answer set for a list of questions. */
export type Answers<Q extends readonly Question[]> = {
  [K in Q[number] as K["name"]]?: K["choices"][number]["value"];
};

export interface ClassifyInput<Q extends readonly Question[]> {
  key: LlmCallKey;
  /** The material the questions are about (a transcript, a request, ...). */
  context: string;
  questions: Q;
  /**
   * Let the model write one short line of reasoning before its answers.
   * Costs ~0.5s of output; buys real accuracy when the answer needs a
   * comparison (is this ALREADY true of the request?), measured on the
   * supersede eval: 33/39 without, 36/39 with. Off for pure labeling.
   */
  reason?: boolean;
  /** The caller's deadline; cancels every model call made. */
  signal: AbortSignal;
  /**
   * The OpenAI Decisions call's share of the deadline, so a slow failure
   * still leaves the prompt fallback room. Unset: Decisions may use it all.
   */
  decisionsBudgetMs?: number;
  /**
   * Questions a Decisions answer must include to count; one it refused
   * sends the whole ask down the prompt path instead. Default: all of them.
   */
  required?: readonly Q[number]["name"][];
}

export interface Classified<Q extends readonly Question[]> {
  answers: Answers<Q>;
  /** Which path answered: for logs and evals, never for behavior. */
  via: "decisions" | "prompt";
}

/** Normalize a model's token to compare against a choice value: markup,
 * quotes, trailing punctuation and Slack's `:name:` colons all drop away. */
const token = (raw: string): string =>
  raw
    .trim()
    .replace(/^[*_`"'([:]+|[*_`"'.)\]:!?,]+$/g, "")
    .toLowerCase();

/** The declared value an answer token names, or undefined. */
const matchChoice = <V extends string>(
  question: Question<string, V>,
  raw: string,
): V | undefined => {
  const wanted = token(raw);
  return question.choices.find((c) => c.value.toLowerCase() === wanted)?.value;
};

/** `who` and `WHO` and `**who**` all name the question `who`. */
const labelOf = (name: string): string => name.toUpperCase();

/**
 * The prompt the plain path sends: the context, then each question as a
 * labeled choice list, then the exact answer block to write. Exported for
 * the unit tests and for judges that want to show it in an eval.
 */
export const renderPrompt = <Q extends readonly Question[]>(
  input: Pick<ClassifyInput<Q>, "context" | "questions" | "reason">,
): string => {
  const blocks = input.questions.map((q) =>
    [
      `${labelOf(q.name)}: ${q.instructions}`,
      ...q.choices.map((c) => `- ${c.value.toUpperCase()}: ${c.description}`),
    ].join("\n"),
  );
  const answerLines = input.questions.map(
    (q) =>
      `${labelOf(q.name)}: <${q.choices.map((c) => c.value.toUpperCase()).join(" | ")}>`,
  );
  return [
    input.context,
    "",
    ...blocks.flatMap((b) => [b, ""]),
    input.reason
      ? "First write ONE short line of reasoning. Then write the answers, each on its own line, exactly in this form:"
      : "Answer with nothing but these lines, exactly in this form:",
    ...answerLines,
  ].join("\n");
};

/**
 * Read an answer block back: for each question, the LAST line labeled with
 * its name, its first word matched against the declared choices. A
 * single-question judge also accepts a final line that is nothing but a
 * choice (models drop the label on one-line answers); a choice buried in a
 * sentence ("I think CHANGE") never counts.
 */
export const parseAnswers = <Q extends readonly Question[]>(
  questions: Q,
  text: string,
): Answers<Q> => {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const answers: Record<string, string> = {};
  for (const q of questions) {
    // Escaped anyway: names are code constants, but a regex built from a
    // string must never trust it.
    const name = q.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const label = new RegExp(
      `^[*_\`#\\s]*${name}[*_\`\\s]*[:=\\-]\\s*(.+)$`,
      "i",
    );
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const hit = label.exec(lines[i] ?? "");
      if (!hit?.[1]) continue;
      const value = matchChoice(q, hit[1].split(/\s+/)[0] ?? "");
      if (value) answers[q.name] = value;
      break;
    }
  }
  const [only] = questions;
  if (questions.length === 1 && only && answers[only.name] === undefined) {
    const value = matchChoice(only, lines.at(-1) ?? "");
    if (value) answers[only.name] = value;
  }
  return answers as Answers<Q>;
};

/** Output budget per path: enough for the answer block (and the reasoning
 * line when asked), with headroom: newer tokenizers clipped "THREAD" to
 * "THRE" at 6 tokens (reply-judge eval, 2026-10-13), and Haiku's "one
 * short line" ran 100+ tokens on a 10-record table and lost its answer to
 * the cap (3 of 8 live replays). The cap bounds cost, not
 * latency: a model that stops early stops early. */
const maxTokensFor = (questions: readonly Question[], reason: boolean) =>
  questions.length * 12 + (reason ? 240 : 4);

const viaDecisions = async <Q extends readonly Question[]>(
  input: ClassifyInput<Q>,
  key: Extract<LlmCallKey, { provider: "openai" }>,
): Promise<Answers<Q>> => {
  const signal =
    input.decisionsBudgetMs === undefined
      ? input.signal
      : AbortSignal.any([
          input.signal,
          AbortSignal.timeout(input.decisionsBudgetMs),
        ]);
  const raw = await askDecisions(key, {
    input: input.context,
    questions: input.questions.map(
      (q): ChoiceQuestion => ({
        name: q.name,
        instructions: q.instructions,
        choices: q.choices.map((c) => ({ ...c })),
      }),
    ),
    signal,
  });
  const answers: Record<string, string> = {};
  for (const q of input.questions) {
    const pick = raw.get(q.name)?.choice;
    const value = pick === undefined ? undefined : matchChoice(q, pick);
    if (value) answers[q.name] = value;
  }
  return answers as Answers<Q>;
};

const viaPrompt = async <Q extends readonly Question[]>(
  input: ClassifyInput<Q>,
): Promise<Answers<Q>> => {
  const reason = input.reason === true;
  const text = await askFastModel(input.key, {
    prompt: renderPrompt(input),
    maxTokens: maxTokensFor(input.questions, reason),
    signal: input.signal,
  });
  return parseAnswers(input.questions, text);
};

const answeredAny = (answers: object): boolean =>
  Object.keys(answers).length > 0;

/** Does this key's best path answer several typed questions in one call?
 * Judges batch differently when it does (see the reply judge). */
export const answersTyped = (key: LlmCallKey): boolean =>
  key.provider === "openai";

/**
 * Ask the questions. Resolves with whatever was answered on the first path
 * that answered anything (Decisions: every required question); throws when
 * no path did, and the judge's fallback then applies.
 */
export const classify = async <const Q extends readonly Question[]>(
  input: ClassifyInput<Q>,
): Promise<Classified<Q>> => {
  const { key } = input;
  if (key.provider === "openai") {
    try {
      const answers = await viaDecisions(input, key);
      const required = input.required ?? input.questions.map((q) => q.name);
      if (required.every((name) => name in answers)) {
        return { answers, via: "decisions" };
      }
    } catch {
      // The prompt path below is the fallback; the judge logs the outcome.
    }
    input.signal.throwIfAborted();
  }
  const answers = await viaPrompt(input);
  if (!answeredAny(answers)) throw new Error("classify: no readable answer");
  return { answers, via: "prompt" };
};
