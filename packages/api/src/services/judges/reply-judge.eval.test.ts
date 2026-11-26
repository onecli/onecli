import { describeJudgeEval } from "../../testing/judge-eval";
import { JUDGE_DEADLINE_MS, judgeReply } from "./reply-judge";

/**
 * THE REPLY-JUDGE EVAL: the labeled corpus through the real judge code and
 * the real models (harness and env: `src/testing/judge-eval.ts`). Every
 * case is shaped on a real channel session or a failure seen there, with
 * made-up names. When the judge gets something wrong in the wild, add the
 * message here (names replaced) with its right answer.
 */

type Expected = "ignore" | "channel" | "thread";

interface Case {
  label: string;
  /** Channel lines, oldest first; the LAST line is the message judged. */
  transcript: string[];
  expect: Expected;
  /** The agent's own recent answers, as production passes them
   * (dispatch.ts `recentAnswers`: `to "..." it answered "..."`). */
  recentAnswers?: string[];
}

const AGENT = "Rafi";
const ROLE =
  "Rafi is the team's operations agent: GitHub PRs, deploys, monday.com boards, call notes, Salesforce.";

/** A short room so every case has context, like a real channel. */
const room = [
  "Alex Kim: morning all",
  "Sam: morning",
  "Alex Kim: what do you think about the new release notes format?",
  `${AGENT}: It reads well, short and scannable.`,
];

const once =
  "Alex Kim: ok cool. for my next question only can you answer it in a thread?";

const CASES: Case[] = [
  // Who is it for: chatter and people talking to each other stay silent.
  {
    label: "chatter: lol",
    transcript: [...room, "Alex Kim: lol nice one"],
    expect: "ignore",
  },
  {
    label: "chatter: single word",
    transcript: [...room, "Sam: wallak"],
    expect: "ignore",
  },
  {
    label: "chatter: thanks",
    transcript: [...room, "Sam: thanks everyone 🙏"],
    expect: "ignore",
  },
  {
    label: "chatter: emoji",
    transcript: [...room, "Noa: :rolling_on_the_floor_laughing:"],
    expect: "ignore",
  },
  {
    label: "other: named first",
    transcript: [...room, "Alex Kim: Noa, did you push the fix yet?"],
    expect: "ignore",
  },
  {
    label: "other: @mention",
    transcript: [...room, "Alex Kim: @Noa what about you?"],
    expect: "ignore",
  },
  {
    label: "other: 'and noa?' after asking the agent",
    transcript: [
      ...room,
      "Alex Kim: are you here?",
      `${AGENT}: Yes, I'm here.`,
      "Alex Kim: and noa?",
    ],
    expect: "ignore",
  },
  {
    label: "other: 'what about you sam?'",
    transcript: [...room, "Alex Kim: what about you sam?"],
    expect: "ignore",
  },
  {
    label: "other: hebrew, named person",
    transcript: [...room, "Alex Kim: נועה תגיד הכנסת את השעות לשעון נוכחות?"],
    expect: "ignore",
  },
  {
    label: "people-only: office tomorrow",
    transcript: [...room, "Alex Kim: is anyone coming to the office tomorrow?"],
    expect: "ignore",
  },
  {
    label: "people-only: hebrew humans",
    transcript: [...room, "Alex Kim: משהו מבני האדם בא מחר למשרד?"],
    expect: "ignore",
  },
  {
    label: "people-only: opinions",
    transcript: [...room, "Sam: who here likes red candy?"],
    expect: "ignore",
  },

  // Who is it for: the agent's own.
  {
    label: "agent: by name, short",
    transcript: [...room, `Alex Kim: rafi what's 12 times 12?`],
    expect: "channel",
  },
  {
    label: "agent: hebrew name",
    transcript: [...room, "Sam: רפי מה השעה?"],
    expect: "channel",
  },
  {
    label: "agent: name alone",
    transcript: [...room, "Sam: רפי?"],
    expect: "channel",
  },
  {
    label: "agent: follow-up to its question",
    transcript: [
      ...room,
      `Alex Kim: rafi can you create a board`,
      `${AGENT}: Sure, what should I call it?`,
      "Alex Kim: yallabalagan",
    ],
    recentAnswers: [
      `to "Alex Kim: rafi can you create a board" it answered "Sure, what should I call it?"`,
    ],
    expect: "channel",
  },
  {
    label: "room: question it can answer",
    transcript: [
      ...room,
      "Alex Kim: does anyone know which apps are connected here?",
    ],
    expect: "channel",
  },
  {
    label: "room: deploy status",
    transcript: [...room, "Sam: does anyone know when the last deploy was?"],
    expect: "channel",
  },

  // Where: long answers thread; short ones stay in the channel.
  {
    label: "where: long checklist -> thread",
    transcript: [
      ...room,
      "Alex Kim: rafi write me a 12 step onboarding checklist for a new engineer",
    ],
    expect: "thread",
  },
  {
    label: "where: migration plan -> thread",
    transcript: [
      ...room,
      "Alex Kim: rafi write a full step-by-step plan to migrate our postgres to aurora, with risks and rollback",
    ],
    expect: "thread",
  },
  {
    label: "where: new channel, short -> channel",
    transcript: ["Dana: rafi what time is it?"],
    expect: "channel",
  },

  // Where: a person's request wins, and a one-time one applies once.
  {
    label: "request: one-time -> next question threads",
    transcript: [
      ...room,
      once,
      `${AGENT}: Sure 👍`,
      "Alex Kim: what is your fav color?",
    ],
    expect: "thread",
  },
  {
    label: "request: one-time -> question after is back in channel",
    transcript: [
      ...room,
      once,
      `${AGENT}: Sure 👍`,
      "Alex Kim: what is your fav color?",
      `${AGENT}: Blue.`,
      "Alex Kim: nice and what your fav animal",
    ],
    expect: "channel",
  },
  {
    label: "request: 'from now on threads' sticks",
    transcript: [
      ...room,
      "Alex Kim: rafi from now on reply in threads",
      `${AGENT}: Sure 👍`,
      "Alex Kim: what is your fav color?",
      `${AGENT}: Blue.`,
      "Alex Kim: rafi what your fav animal",
    ],
    expect: "thread",
  },
  {
    label: "request: back to the channel",
    transcript: [
      ...room,
      "Alex Kim: rafi reply in threads",
      `${AGENT}: Sure 👍`,
      "Alex Kim: rafi stop with threads, talk in the chat",
      `${AGENT}: Sure 👍`,
      "Alex Kim: rafi what time is it?",
    ],
    expect: "channel",
  },
  {
    label: "request: hebrew 'בטרייד'",
    transcript: [
      ...room,
      "Alex Kim: רפי תענה לי בטרייד מעכשיו",
      `${AGENT}: Sure 👍`,
      "Alex Kim: רפי מה השעה?",
    ],
    expect: "thread",
  },
];

describeJudgeEval({
  name: "reply",
  cases: CASES.map((c) => ({ label: c.label, input: c, expect: c.expect })),
  run: (key, c) =>
    judgeReply({
      key,
      signal: AbortSignal.timeout(JUDGE_DEADLINE_MS),
      agent: { id: "eval-agent", name: AGENT },
      instructions: ROLE,
      transcript: c.transcript,
      ...(c.recentAnswers && { recentAnswers: c.recentAnswers }),
    }),
  label: (verdict): Expected | "no-verdict" =>
    verdict === null
      ? "no-verdict"
      : verdict.reply
        ? verdict.placement
        : "ignore",
  floor: 0.85,
});
