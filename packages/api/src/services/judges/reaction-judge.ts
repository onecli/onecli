import { resolveLlmCallKey } from "../llm-direct-call";
import { defineJudge } from "./judge";

/**
 * THE REACTION JUDGE: the receipt reaction that marks a message "seen"
 * while the turn runs - one emoji relevant to the message, from a fixed
 * allowlist. Cosmetic, so it is the quietest judge: `eyes` on every failure,
 * a short deadline, debug-level logs, and never an error into the ingest
 * path that calls it.
 */

/**
 * The Slack reactions the model may pick from, each with when it fits: the
 * output boundary, and what the model reads. Neutral "seen" marks only. The
 * sender reads the mark as the agent's first reply, so one that passes a
 * verdict on the message (a question mark: "I didn't understand"; a
 * thumbs-up on "the deploy failed"; a rising chart on falling sales) says
 * something the agent never said. `eyes` is offered as the default, so the
 * model is never pushed into a topical pick that does not fit.
 */
export const REACTION_CHOICES = [
  {
    value: "eyes",
    description: "The default: seen, when no other choice clearly fits.",
  },
  { value: "wave", description: "A greeting or a sign-off." },
  {
    value: "thinking_face",
    description: "A question to answer or a problem to think through.",
  },
  { value: "mag", description: "Something to look up, check or investigate." },
  { value: "bulb", description: "An idea or a suggestion." },
  { value: "calendar", description: "Dates, scheduling or a meeting." },
  { value: "bar_chart", description: "Numbers, metrics or a report." },
] as const;
export type Reaction = (typeof REACTION_CHOICES)[number]["value"];

export const FALLBACK_REACTION: Reaction = "eyes";

/** Hard ceiling on the pick: the receipt lands promptly or not at all. */
const CHOOSER_TIMEOUT_MS = 1_500;
/** A pick needs the gist, not a transcript. */
const TEXT_CLAMP = 500;

const QUESTIONS = [
  {
    name: "emoji",
    instructions:
      "Pick the single most fitting acknowledgment emoji for this chat message.",
    choices: REACTION_CHOICES,
  },
] as const;

const judgeReaction = defineJudge<{ text: string }, Reaction>({
  name: "reaction",
  deadlineMs: CHOOSER_TIMEOUT_MS,
  fallback: FALLBACK_REACTION,
  quiet: true,
  decide: async (input, ask) => {
    const { emoji } = await ask({
      context: `Message: ${input.text.slice(0, TEXT_CLAMP)}`,
      questions: QUESTIONS,
    });
    return emoji ?? FALLBACK_REACTION;
  },
  describe: (v) => v,
});

/**
 * Choose the receipt reaction for an inbound message. Resolves the agent's
 * fast-model key itself (the callers are detached receipt tasks) and never
 * throws: no key, any failure, or the deadline all give `eyes`.
 */
export const chooseReaction = async (input: {
  agent: { id: string; workspaceId: string };
  organizationId: string;
  text: string;
}): Promise<Reaction> => {
  const signal = AbortSignal.timeout(CHOOSER_TIMEOUT_MS);
  const resolved = await resolveLlmCallKey(
    input.agent,
    input.organizationId,
  ).catch(() => null);
  if (!resolved?.ok) return FALLBACK_REACTION;
  return judgeReaction({ key: resolved.key, signal, text: input.text });
};
