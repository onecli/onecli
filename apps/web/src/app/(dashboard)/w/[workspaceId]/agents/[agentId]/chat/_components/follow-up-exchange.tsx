"use client";

import { Message, MessageContent } from "@onecli/ui/components/message";
import type { Turn } from "@/lib/api/types";
import type { RenderedTurn, SentNowOutcome } from "@/lib/chat/transcript";
import { isAutomationTurn, isJoiningTurn } from "@/lib/chat/turns";
import { AgentAnswer } from "./agent-answer";
import { AutomationTurnHeader } from "./automation-turn";
import { NarrationText } from "./narration-text";
import { originLabel } from "./origin-label";
import { SendNowAction } from "./send-now-action";
import { UserBubble } from "./user-bubble";

/**
 * A message sent while the agent was working, and what the agent said back
 * to it: the person's bubble, then the agent's reply right under it, so a
 * mid-turn question is answered where it was asked instead of reading as
 * ignored. Without a reply (the agent folded it into its closing answer)
 * the bubble stands alone, and the turn's answer below covers it.
 *
 * The reply arrives in two shapes, both keyed by the follow-up's own id in
 * the transcript: its DELTAS while the agent is still writing it (the live
 * reply, rendered as transient narration, exactly like the turn's own
 * streaming tail: untrusted mid-turn text, never markdown), and then the
 * durable `text` that replaces them (the answer, as markdown). A follow-up
 * whose reply ended up as the turn's closing words gets no `text` of its
 * own: those words were streamed under it, then settled as the TURN's
 * answer, so its live tail is shown only while the turn still runs
 * (`targetActive`) and dies with the turn, exactly like the turn's own
 * tail. The follow-up row has no terminal event of its own to end it.
 *
 * A wake that joined the turn is the platform's instruction, not the
 * person's words: it gets the automation header, never a bubble.
 *
 * A WAITING follow-up may offer SEND NOW (`sendNow`, present when the
 * turn could take it at all; the turn knows whether a tool is running):
 * its status line gains the control, and later the agent's answer to it.
 */
export const FollowUpExchange = ({
  followUp,
  rendered,
  targetActive = false,
  sendNow,
}: {
  followUp: Turn;
  /** What the transcript holds under the follow-up's own id. */
  rendered?: RenderedTurn;
  /** Whether the turn this follow-up rides is still running: the only
   * time its live tail is current. */
  targetActive?: boolean;
  /** SEND NOW is possible for this message (it waits on a live run);
   *  `toolRunning` says whether the run is inside a tool right now, the
   *  only time it helps, and `outcome` is the agent's answer once it
   *  lands. */
  sendNow?: { toolRunning: boolean; outcome?: SentNowOutcome };
}) => {
  const liveReply =
    targetActive && rendered?.liveText.trim() ? rendered.liveText : "";
  const joining = isJoiningTurn(followUp);
  return (
    <>
      {isAutomationTurn(followUp) ? (
        <AutomationTurnHeader
          source={followUp.source}
          title={followUp.message}
        />
      ) : (
        <UserBubble
          text={followUp.message}
          origin={originLabel(followUp.source)}
          conversationId={followUp.conversationId}
          attachments={followUp.attachments}
          // Steering into the live run: received, being folded in. The hint
          // drops once the run consumes it (`joined`): the quiet mark's whole
          // lifetime is the in-between.
          {...(joining && { hint: "Received, folding it in" })}
          {...(joining &&
            sendNow && {
              action: (
                <SendNowAction
                  followUpId={followUp.id}
                  conversationId={followUp.conversationId}
                  toolRunning={sendNow.toolRunning}
                  outcome={sendNow.outcome}
                />
              ),
            })}
        />
      )}
      {rendered?.text ? (
        <Message align="start">
          <MessageContent className="min-w-0">
            <AgentAnswer text={rendered.text} />
          </MessageContent>
        </Message>
      ) : liveReply ? (
        <Message align="start">
          <MessageContent className="min-w-0">
            <NarrationText text={liveReply} live />
          </MessageContent>
        </Message>
      ) : null}
    </>
  );
};
