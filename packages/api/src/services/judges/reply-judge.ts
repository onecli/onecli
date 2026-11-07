import { defineJudge, type Ask } from "./judge";

/**
 * THE REPLY JUDGE (point of contact): an overheard channel message -
 * is it for the agent, and if so, does it answer in the channel or a thread?
 *
 * It classifies WHO the message is addressed to rather than asking "should
 * the agent reply?" - a yes/no framing says "reply" to almost anything once
 * the agent has been chatting (measured on a live channel: ~16 of 45
 * overheard messages wrongly passed). For the agent's own messages it also
 * picks WHERE, reading the room the way a person scrolling up would, and a
 * person's explicit request about where ("reply in threads", "בטרייד")
 * always wins over the judge's own pick.
 *
 * `null` means no verdict (refused, timed out, unreadable): the caller lets
 * the agent itself decide. The wording is tuned per path against
 * `reply-judge.eval.test.ts`: change it only with a fresh eval run.
 */

/** The judge's whole budget: it runs before Slack's 3s ack window. */
export const JUDGE_DEADLINE_MS = 2_000;
/** Decisions' share, so a slow failure still leaves the prompt path room. */
const DECISIONS_BUDGET_MS = 1_000;
/** Per-line and brief clamps: a verdict needs the room's gist, not a dump. */
const LINE_CLAMP = 400;
const BRIEF_CLAMP = 1_500;

export interface ReplyJudgeInput {
  agent: { id: string; name: string };
  /** The agent's own brief (its Instructions), if any. */
  instructions: string | null;
  /** The agent's own recent answers in the room (oldest first). */
  recentAnswers?: string[];
  /** Recent channel lines, oldest first, the new message LAST. */
  transcript: string[];
}

/** Where an answer goes: in a thread under the message, or the channel. */
export type ReplyPlacement = "thread" | "channel";

export type JudgeVerdict =
  | { reply: true; placement: ReplyPlacement }
  | { reply: false };

const whoQuestion = (name: string) =>
  ({
    name: "who",
    instructions: "Who is the FINAL message addressed to?",
    choices: [
      {
        value: "agent",
        description: `Meant for ${name}: uses their name (any spelling or language), or answers or continues what ${name} just asked or said - including a short reply like a name or a single word right after ${name} asked a question.`,
      },
      {
        value: "other",
        description: `Meant for, or asks about, a specific other person: names or @mentions someone else and not ${name} (even a short "and Dana?" or "what about you Dana?", in any language). This wins over everything except ${name}'s own name.`,
      },
      {
        value: "room",
        description: `A question or request to the whole group, nobody named, that ${name} could actually answer or do from knowledge, tools, or data (facts, docs, status, tasks). NOT questions about the people themselves (their plans, whereabouts, opinions, feelings, who is coming in), which only they can answer, and NOT anything aimed at "the humans" / "people" (in any language).`,
      },
      {
        value: "none",
        description:
          "Chatter, greetings, reactions, jokes, single words, nonsense, system notices, or people talking to each other.",
      },
    ],
  }) as const;

const whereQuestion = (name: string) =>
  ({
    name: "where",
    instructions: `If ${name} answers, where would a thoughtful teammate in THIS channel answer? Check in order: 1. the final message is part of an exchange already in a thread: there. 2. otherwise do what people here do ([thread: N replies] marks a message people answered in a thread). 3. no clear pattern yet: the channel.`,
    choices: [
      {
        value: "channel",
        description:
          "In the channel like everyone else: a short answer or quick back-and-forth, in a room that talks in the channel, or a channel with no clear pattern yet.",
      },
      {
        value: "thread",
        description:
          "In a thread under the message: the room talks in threads, the message continues a thread exchange, or the answer is long (a plan, a list, steps, a write-up, a poem).",
      },
    ],
  }) as const;

const requestQuestion = (name: string) =>
  ({
    name: "request",
    instructions: `Did anyone ask ${name} to reply in threads, or in the channel itself (any language)? Consider only the MOST RECENT such request. A one-question request ("for my next question only", "just this once") covers the first real question after it (an acknowledgement like "Sure" does not use it up) and no longer applies once that question was answered.`,
    choices: [
      { value: "threads", description: "The request in force: threads." },
      { value: "channel", description: "The request in force: the channel." },
      {
        value: "none",
        description: "Nobody asked, or a one-time request was already used.",
      },
    ],
  }) as const;

/**
 * Asked on its own only when the room's recent text talks about threads at
 * all, so most messages never pay for it - and kept apart from the who/where
 * question on the prompt path so that question stays sharp.
 */
const THREAD_TALK = /thread|טרייד|שרשור|flat|פלאט|channel|ערוץ/i;

const roomContext = (input: ReplyJudgeInput): string => {
  const name = input.agent.name;
  const lines = input.transcript.map((line) => line.slice(0, LINE_CLAMP));
  return [
    `A team chat. The participants are people and an AI assistant named "${name}".`,
    ...(input.instructions
      ? [`${name}'s role: ${input.instructions.slice(0, BRIEF_CLAMP)}`]
      : []),
    "Read the recent messages for context, then judge ONLY the final message.",
    "",
    "Recent messages, oldest first:",
    ...lines.slice(0, -1),
    ...(input.recentAnswers && input.recentAnswers.length > 0
      ? ["", `${name}'s latest replies:`, ...input.recentAnswers]
      : []),
    "",
    "Final message:",
    lines.at(-1) ?? "",
  ].join("\n");
};

/** The request about where, asked only when the room talks about it. */
const askRequest = async (
  input: ReplyJudgeInput,
  ask: Ask,
): Promise<ReplyPlacement | null> => {
  if (!input.transcript.some((line) => THREAD_TALK.test(line))) return null;
  try {
    const { request } = await ask({
      context: roomContext(input),
      questions: [requestQuestion(input.agent.name)],
    });
    return request === "threads"
      ? "thread"
      : request === "channel"
        ? "channel"
        : null;
  } catch {
    return null;
  }
};

const verdictOf = (
  who: string | undefined,
  placement: ReplyPlacement,
): JudgeVerdict | null =>
  who === "agent" || who === "room"
    ? { reply: true, placement }
    : who === "other" || who === "none"
      ? { reply: false }
      : null;

export const judgeReply = defineJudge<ReplyJudgeInput, JudgeVerdict | null>({
  name: "reply",
  deadlineMs: JUDGE_DEADLINE_MS,
  fallback: null,
  decide: async (input, ask) => {
    const name = input.agent.name;
    const context = roomContext(input);
    const who = whoQuestion(name);
    const where = whereQuestion(name);
    if (ask.typed) {
      // A typed key answers all three in ONE call; it must answer `who`
      // (a refusal there sends the ask down the prompt path).
      const answers = await ask({
        context,
        questions: [who, where, requestQuestion(name)],
        decisionsBudgetMs: DECISIONS_BUDGET_MS,
        required: ["who"],
      });
      const placement: ReplyPlacement =
        answers.request === "threads"
          ? "thread"
          : answers.request === "channel"
            ? "channel"
            : answers.where === "thread"
              ? "thread"
              : "channel";
      return verdictOf(answers.who, placement);
    }
    // The prompt path keeps who/where sharp by asking the request about
    // where apart, in parallel (no added latency), and only when the room
    // talks about threads at all.
    const [answers, requested] = await Promise.all([
      ask({ context, questions: [who, where] }),
      askRequest(input, ask),
    ]);
    const placement: ReplyPlacement =
      requested ?? (answers.where === "thread" ? "thread" : "channel");
    return verdictOf(answers.who, placement);
  },
  describe: (v) =>
    v === null ? "unreadable" : v.reply ? `reply ${v.placement}` : "silent",
  logFields: (input) => ({ agentId: input.agent.id }),
});
