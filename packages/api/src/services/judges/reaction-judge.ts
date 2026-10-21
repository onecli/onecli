import { resolveLlmCallKey } from "../llm-direct-call";
import { defineJudge } from "./judge";

/**
 * THE REACTION JUDGE: the receipt reaction that marks a message "seen"
 * while the turn runs - one emoji relevant to the message, from a fixed
 * allowlist. Cosmetic, so it is the quietest judge: `eyes` on every failure,
 * a short deadline, debug-level logs, and never an error into the ingest
 * path that calls it.
 */

/** Slack reaction names the model may pick from: the output boundary. */
export const REACTION_ALLOWLIST = [
  "eyes",
  "wave",
  "thumbsup",
  "thinking_face",
  "mag",
  "memo",
  "rocket",
  "bulb",
  "question",
  "bug",
  "book",
  "gear",
  "calendar",
  "chart_with_upwards_trend",
] as const;
export type Reaction = (typeof REACTION_ALLOWLIST)[number];

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
    choices: REACTION_ALLOWLIST.map((value) => ({
      value,
      description: value.replaceAll("_", " "),
    })),
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
