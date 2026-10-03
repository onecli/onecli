import type { PeerTaskOutcome } from "@onecli/agent-protocol";
import type { Turn } from "@/lib/api/types";
import type { RenderedTurn } from "./transcript";

/**
 * A PAIR conversation (PR 5b, one agent and one peer agent) read as a plain
 * two-party chat: this agent's words on one side, the peer's on the other,
 * and nothing else. The regular thread would show the machinery — the
 * `message_agent` tool rows, the model's narration ("Replied with 4,
 * delivery pending…"), the "To Ray: 4" notice — which is exactly what a
 * person opening "View conversation" does not want to read.
 *
 * Both sides come from structured places, never from parsing prose:
 *
 *  - THE PEER'S words are the turn row's `message` on a turn the control
 *    plane created for a delivery (`source: "agent"`, no speaker). The
 *    frame `Name (agent): ` is our own template around the words, so
 *    stripping it is stripping our own prefix, not guessing at the peer's.
 *  - THIS AGENT'S words are the `peerMessages` folded from the sender's
 *    record (`recordSentMessage`): a born-done turn with an EMPTY `message`
 *    and the words on its notice's `peerMessage` stamp. A send made from
 *    the direct chat lands here the same way.
 *
 * In practice a turn is one or the other (the record row has no incoming
 * words; a delivered turn's reply is recorded as its own row), but the fold
 * is per turn and takes both in order, so nothing is lost if a stamp ever
 * lands on the delivered turn itself.
 *
 * Two marks from peer tasks (the PR after 5b), both read from the platform's
 * stamps: an own bubble that OPENED a task for a person wears a small
 * caption, and the pair record of a task CLOSING draws the dialog's last
 * line (reported back, or why it ended without a report).
 *
 * What is deliberately NOT here: the agent's narration text, tool calls,
 * notices, live deltas, attachments. A turn that FAILED (the sandbox
 * errored, no model key) shows a quiet line so the silence is not a
 * mystery; a turn that finished without a `message_agent` is just silence,
 * as it would be in any chat.
 */
export type PairBubble =
  | { kind: "peer"; key: string; text: string }
  /** `forPerson`: this message opened a peer task (a person asked for it). */
  | { kind: "own"; key: string; text: string; forPerson: boolean }
  | { kind: "failed"; key: string }
  /** A peer task ended on this turn: the dialog's closing line. */
  | { kind: "task_closed"; key: string; outcome: PeerTaskOutcome };

/** Our own frame around a delivered peer message: `Name (agent): words`. */
const PEER_FRAME = /^[^\n]{1,80}? \(agent\): /;

export const stripPeerFrame = (message: string): string =>
  message.replace(PEER_FRAME, "");

export const pairBubbles = (
  turns: readonly Turn[],
  folded: ReadonlyMap<string, RenderedTurn>,
): PairBubble[] => {
  const bubbles: PairBubble[] = [];
  for (const turn of turns) {
    // A delivery from the peer: the platform's own turn, words framed.
    if (turn.source === "agent" && turn.userId === null && turn.message) {
      bubbles.push({
        kind: "peer",
        key: `${turn.id}:peer`,
        text: stripPeerFrame(turn.message),
      });
    }
    const rendered = folded.get(turn.id);
    rendered?.peerMessages.forEach((text, index) => {
      bubbles.push({
        kind: "own",
        key: `${turn.id}:own:${index}`,
        text,
        forPerson: rendered.peerMessagesOpeningTask.has(index),
      });
    });
    if (rendered?.peerTaskClosed) {
      bubbles.push({
        kind: "task_closed",
        key: `${turn.id}:task`,
        outcome: rendered.peerTaskClosed,
      });
    }
    if (
      turn.status === "failed" &&
      (rendered?.peerMessages.length ?? 0) === 0
    ) {
      bubbles.push({ kind: "failed", key: `${turn.id}:failed` });
    }
  }
  return bubbles;
};

/** The pair view's words for a task closing, by outcome. Short and plain:
 * the dialog's last line, not a report. */
export const taskClosedLine = (outcome: PeerTaskOutcome): string =>
  ({
    reported: "Reported back to the person.",
    budget: "Out of messages. Closed without a report.",
    expired: "No progress for a while. Closed without a report.",
    blocked: "Messaging was blocked. The task closed.",
    removed: "The contact was removed. The task closed.",
    undeliverable: "The message could not be delivered. The task closed.",
  })[outcome];
