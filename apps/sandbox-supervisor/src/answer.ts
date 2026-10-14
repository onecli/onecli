import {
  isPlatformSteerId,
  type AgentEvent,
  type HarnessEvent,
} from "@onecli/agent-protocol";

/**
 * THE TURN'S ANSWER: which of the agent's words the transcript keeps.
 *
 * THE ANSWER IS WHAT THE AGENT SAID AFTER ITS LAST TOOL CALL, NOT THE WHOLE
 * TURN (user decision, 2026-08-31). A working turn interleaves narration with
 * tools ("Let me check the logs." → bash → "Now the config." → read → the
 * actual finding), and gluing those together published the agent's running
 * commentary AS its answer: the multi-screen chat walls the response-style
 * prompt could not fix, because every individual message was already short.
 * Narration is PROGRESS, not the record. It still streams (`text.delta`
 * reaches every live tail and is ephemeral by the delta law); only the
 * closing words are what the transcript keeps and the channel posts.
 *
 * A TOOL CALL ends a stretch of talk, because it is a structural break the
 * model cannot write across: it must stop and wait for the result. Thinking
 * is NOT a break. Reasoning interleaves inside one message ("The root cause
 * is " → thinks → "the retry loop."), and cutting there would publish half a
 * sentence.
 *
 * Inside a stretch, the harness's MESSAGE FRAMING (`messageId`) decides where
 * one message ends and the next begins. Without it, two messages written with
 * no tool between them (the agent finishing one thought, then answering a
 * message the user sent mid-turn) arrive as one run of deltas and were glued
 * mid-sentence ("…report.md.Yes, I can also email it."). With it, each message
 * stays whole and the answer joins them as paragraphs. A harness that does
 * not frame its output reads as one message per stretch, which is exactly
 * the rule above and nothing more.
 *
 * Framing also carries CORRECTIONS (`text.replace`): a provider attempt that
 * failed mid-stream and was replayed from the top is retracted, so the
 * abandoned half-sentence never lands in the stored answer ahead of the
 * replayed one.
 */

/**
 * Memory guard on the words one turn keeps. Not a product limit (the wire
 * applies the visible one), just the point past which a runaway model stops
 * being allowed to grow this process's heap. It bounds each stretch, and two
 * are live at once (the current one and the never-silent fallback), so the
 * true ceiling is 2× this: still bounded, which is the whole point.
 */
export const MAX_ANSWER_CHARS = 256_000;

interface Message {
  /** The harness's message id; undefined for unframed output. */
  readonly id: string | undefined;
  text: string;
}

/** The talk between two tool calls: one or more messages, in order. */
interface Stretch {
  readonly messages: Message[];
  /** Sum of `messages[].text` lengths, kept so the cap costs nothing. */
  chars: number;
}

const emptyStretch = (): Stretch => ({ messages: [], chars: 0 });

/** A stretch as answer text: each message trimmed, blanks dropped, and the
 * rest kept as separate paragraphs, never glued. */
const textOf = (stretch: Stretch): string =>
  stretch.messages
    .map((message) => message.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");

/** A reply handed over to the follow-up it answers: store it under that row. */
export interface HandedReply {
  followUpId: string;
  reply: string;
}

interface AnswerTracker {
  /**
   * Feed every event of the turn, in order. Ignores what it does not use.
   * Returns the replies this event handed over: ones `claim` held because
   * they were the answer's only words at the time, now released because the
   * agent went on to say something else.
   */
  observe(event: HarnessEvent): HandedReply[];
  /**
   * Hand a message the agent wrote as a REPLY to a mid-turn follow-up over to
   * that follow-up: it leaves the turn's answer, so the reply is stored once,
   * under the message it answers. Matched by its text (the harness reports
   * the reply exactly as it streamed it), the latest copy first.
   *
   * The turn's closing words are never taken: one message answering the
   * original request and the follow-up together, or the last thing said
   * before a stop, stays the turn's answer. Confirmed LIVE (the join arrives
   * the moment the reply's message closes, while the turn still runs), a
   * reply that is all the answer has right now may stop being so a moment
   * later, when the agent goes back to work. So it is not refused but held:
   * `observe` hands it over at the first event showing the agent moved on
   * (the next tool call, or the next words), and a turn that ends before
   * then keeps it as its answer. True when the reply is handed over now
   * (store it under the follow-up); false when it is held.
   */
  claim(followUpId: string, reply: string): boolean;
  /**
   * The answer so far: what the agent said after its last tool call, or,
   * when it said nothing there (a stop, a crash, a failure mid-work), the
   * last stretch that said something. Never silent while anything was said:
   * posting nothing would read as the agent ignoring the person. Empty only
   * when the agent never said a word.
   */
  answer(): string;
}

export const createAnswerTracker = (): AnswerTracker => {
  let current = emptyStretch();
  /** The last stretch that closed with words in it: the fallback. */
  let previous = emptyStretch();
  /** Replies claimed while they were the answer's only words, kept in the
   * answer until the turn says something else (`claim` / `observe`). */
  let held: HandedReply[] = [];
  /**
   * Ids of messages in stretches the answer has let go of: narration that is
   * no longer the answer or its fallback. A correction for one of them
   * changes nothing the turn keeps, and must not come back as new text.
   * One short id per message, so it grows with the turn and nothing else.
   */
  const retired = new Set<string>();

  const retire = (stretch: Stretch): void => {
    for (const message of stretch.messages) {
      if (message.id !== undefined) retired.add(message.id);
    }
  };

  /**
   * Where a message lives. A framed id is looked up in both live stretches,
   * because a harness can stream more of a message (or correct it) after the
   * tool call that closed its stretch began: the call is announced while the
   * response is still streaming, and the response is what a retry replays.
   * Unframed output has no identity across a tool call, so it only ever
   * continues the current stretch.
   */
  const find = (
    id: string | undefined,
  ): { stretch: Stretch; message: Message } | undefined => {
    const stretches = id === undefined ? [current] : [current, previous];
    for (const stretch of stretches) {
      const message = stretch.messages.find((m) => m.id === id);
      if (message) return { stretch, message };
    }
    return undefined;
  };

  const append = (id: string | undefined, text: string): void => {
    if (text.length === 0) return;
    const found = find(id);
    if (!found && id !== undefined && retired.has(id)) return;
    const stretch = found?.stretch ?? current;
    if (stretch.chars >= MAX_ANSWER_CHARS) return;
    if (found) {
      found.message.text += text;
    } else {
      stretch.messages.push({ id, text });
    }
    stretch.chars += text.length;
  };

  const replace = (id: string, text: string): void => {
    const found = find(id);
    if (!found) {
      // A correction for a message never streamed: the harness recovered
      // text it had held back. It is new text, so it is appended (a retired
      // id is refused there, like any late text for one).
      append(id, text);
      return;
    }
    const { stretch, message } = found;
    const room = Math.max(
      0,
      MAX_ANSWER_CHARS - (stretch.chars - message.text.length),
    );
    const kept = text.slice(0, room);
    stretch.chars += kept.length - message.text.length;
    message.text = kept;
  };

  /** A tool call ends the stretch. An empty one never displaces the
   * fallback: back-to-back tool calls must not erase the last words said. */
  const closeStretch = (): void => {
    if (textOf(current)) {
      retire(previous);
      previous = current;
    } else {
      retire(current);
    }
    current = emptyStretch();
  };

  /** The stretch the answer comes from: the closing one, or the fallback. */
  const answerStretch = (): Stretch => (textOf(current) ? current : previous);

  /** Where the latest message with exactly these words sits, if anywhere. */
  const lastWith = (
    words: string,
  ): { stretch: Stretch; index: number } | undefined => {
    for (const stretch of [current, previous]) {
      for (let index = stretch.messages.length - 1; index >= 0; index -= 1) {
        if (stretch.messages[index]?.text.trim() === words) {
          return { stretch, index };
        }
      }
    }
    return undefined;
  };

  /** Take the reply out of the answer, unless it is the answer's only words
   * (or `force`: the agent moved on, so the reply is the follow-up's even
   * when nothing else has been said yet). */
  const takeOut = (reply: string, force = false): boolean => {
    const words = reply.trim();
    if (!words) return false;
    const found = lastWith(words);
    // A reply from a stretch the answer already let go of (narration before
    // a later tool call): nothing to take out, and it is the follow-up's.
    if (!found) return true;
    const { stretch, index } = found;
    const rest: Stretch = {
      messages: stretch.messages.filter((_, i) => i !== index),
      chars: 0,
    };
    // Those are the answer's only words: they stay the turn's answer.
    if (!force && stretch === answerStretch() && !textOf(rest)) return false;
    const [message] = stretch.messages.splice(index, 1);
    stretch.chars -= message?.text.length ?? 0;
    return true;
  };

  /** Hand over every held reply the answer can now let go of. */
  const release = (force = false): HandedReply[] => {
    if (held.length === 0) return [];
    const handed = held.filter((entry) => takeOut(entry.reply, force));
    held = held.filter((entry) => !handed.includes(entry));
    return handed;
  };

  return {
    observe(event) {
      switch (event.type) {
        case "text.delta":
          append(event.messageId, event.text);
          return release();
        case "text.replace":
          replace(event.messageId, event.text);
          return release();
        case "tool.started": {
          // The agent went back to work: whatever it said back to the
          // follow-up was its reply, complete, and is handed over NOW (a
          // channel reader gets it while the agent works). Taken out of the
          // answer even when it was the only words said, BEFORE the stretch
          // closes: the fallback then keeps what the turn said before the
          // reply, and a stop during this tool leaves the reply under the
          // message it answered rather than as the turn's answer.
          const handed = release(true);
          closeStretch();
          return handed;
        }
        case "tool.finished":
          closeStretch();
          return [];
        default:
          return [];
      }
    },
    claim(followUpId, reply) {
      if (takeOut(reply)) return true;
      if (reply.trim()) held.push({ followUpId, reply });
      return false;
    },
    answer: () => textOf(answerStretch()),
  };
};

/**
 * A harness event as the wire carries it, or null when it has no wire form.
 *
 * Message framing and follow-up replies end here: the supervisor is their
 * only reader, so `messageId` and `replyTo` are dropped, and corrections
 * and finished replies are consumed (a reply reaches the transcript as its
 * own `text` event, and streams there as deltas keyed by the follow-up, see
 * `replyTargetOf`). Keeping them off the wire keeps every runner and
 * control plane, old or new, reading the same vocabulary.
 */
export const toWireEvent = (event: HarnessEvent): AgentEvent | null => {
  switch (event.type) {
    case "text.replace":
    case "message.replied":
      return null;
    case "text.delta":
      return { type: "text.delta", text: event.text };
    default:
      return event;
  }
};

/**
 * The follow-up row a harness event travels under on the wire, when it is
 * not the turn's own: a delta the harness marked as a steered follow-up's
 * reply streams under that follow-up, so a reader sees the reply being
 * written under the message it answers, exactly where the durable `text`
 * the handover stores will replace it. Undefined for everything else, and
 * for the platform's own steer (the ceiling warning), which has no row.
 */
export const replyTargetOf = (event: HarnessEvent): string | undefined =>
  event.type === "text.delta" &&
  event.replyTo !== undefined &&
  !isPlatformSteerId(event.replyTo)
    ? event.replyTo
    : undefined;
