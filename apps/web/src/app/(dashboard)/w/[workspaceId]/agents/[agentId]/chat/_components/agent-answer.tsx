"use client";

import { isNoReply } from "@onecli/agent-protocol/text";
import { Bubble, BubbleContent } from "@onecli/ui/components/bubble";
import { cn } from "@onecli/ui/lib/utils";
import { useSmoothText } from "@/lib/chat/use-smooth-text";
import { AnswerActions } from "./answer-actions";
import { ChatMarkdown } from "./chat-markdown";
import { ConnectorSuggestions } from "./connect-suggestions";
import { StayedSilentNote } from "./stayed-silent-note";

/**
 * The agent's words, from the first streamed word to the stored answer, in
 * ONE element: a draft settles into the record in place, so nothing swaps,
 * jumps or changes size under the reader when the turn ends.
 *
 * Two roles share the element (and the slot in the turn), so a text that
 * changes role never remounts:
 *
 * - `answer`: what the agent says to the person. While `draft` (still being
 *   written, and no final answer yet) it carries a small "still writing"
 *   dot after its last word, and the dot goes the moment the durable answer
 *   lands. That is the one signal of "this is final".
 * - `lead`: the opening sentence the agent wrote before its first tool call
 *   ("I'll check the logs first."), kept above the work in a quieter color.
 *   Live only: history carries no deltas.
 *
 * `live` says the text is arriving in front of the reader: it is revealed at
 * a steady pace (`useSmoothText`) with each new word fading in. Text that is
 * already complete when it mounts (history, a page load) is shown at once,
 * with only a short fade for an answer that was not watched being written.
 *
 * SECURITY: the text is untrusted model output. It renders only through
 * `ChatMarkdown` (no raw HTML, our URL gate). Connect cards come from the
 * FINAL answer and the connection tool's own links, never from a draft or
 * the lead, which are progress text.
 */
export const AgentAnswer = ({
  text,
  role = "answer",
  draft = false,
  live = false,
  toolConnectLinks = "",
  sentAt,
}: {
  text: string;
  role?: "answer" | "lead";
  /** Still being written: the final answer has not landed. */
  draft?: boolean;
  /** Arriving in front of the reader (reveal it), as opposed to complete
   *  on mount. Read once, when the element mounts. */
  live?: boolean;
  /** Connect links the turn's `request_app_connection` calls returned
   * (`connectLinkTextFromTools`), so the card renders even when the answer
   * paraphrased or dropped the link. */
  toolConnectLinks?: string;
  /** When the final answer was sent (ISO), for its actions row. */
  sentAt?: string | null;
}) => {
  const shown = useSmoothText(text, { animate: live, final: !draft });
  // The reveal is still catching up: keep the fade and the open-syntax
  // completion on until the last word is on screen.
  const revealing = shown !== text;
  const answer = role === "answer";

  if (answer && isNoReply(text)) return <StayedSilentNote />;

  return (
    <>
      <Bubble
        variant="ghost"
        data-role={role}
        data-draft={answer && draft ? "" : undefined}
        className={cn(
          // A complete answer nobody watched being written still arrives
          // gently; one revealed word by word needs no extra fade.
          !live &&
            "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300",
        )}
      >
        <BubbleContent>
          <ChatMarkdown
            text={shown}
            streaming={draft || revealing}
            draft={answer && draft}
            suppressConnectLinks={answer}
            className={cn(
              // Only the text color eases (a lead settling to an answer):
              // `transition-colors` also animates backgrounds and borders,
              // and a theme switch then dims the whole answer for 300 ms.
              "transition-[color] duration-300",
              !answer && "text-muted-foreground",
            )}
          />
        </BubbleContent>
      </Bubble>
      {/* Copy and the time: under the FINAL answer only, once its last
          word is on screen (never a draft, the lead, a no-reply). */}
      {answer && !draft && !revealing && (
        <AnswerActions text={text} at={sentAt} />
      )}
      {/* Reads the FINAL answer and the connection tool's own links, never a
          draft or the lead, which are untrusted progress text. */}
      {answer && !draft && (
        <ConnectorSuggestions
          text={toolConnectLinks ? `${text}\n${toolConnectLinks}` : text}
        />
      )}
    </>
  );
};
