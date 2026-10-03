"use client";

import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
} from "@onecli/ui/components/message-scroller";
import { Bubble } from "@onecli/ui/components/bubble";
import { Message, MessageContent } from "@onecli/ui/components/message";
import type { Turn } from "@/lib/api/types";
import type { RenderedTurn } from "@/lib/chat/transcript";
import { pairBubbles, taskClosedLine } from "@/lib/chat/pair-bubbles";
import { FollowingViewport } from "../../chat/_components/following-viewport";
import { LoadOlderSentinel } from "../../chat/_components/load-older-sentinel";
import { TextBubbleContent } from "../../chat/_components/text-bubble-content";

interface PairThreadProps {
  /** Which agent's pair conversation this is: its words are the dark side. */
  agentName: string;
  peerName: string;
  turns: Turn[];
  folded: ReadonlyMap<string, RenderedTurn>;
  /** THIS side is past the turn cap: one quiet line at the end says so,
   *  because a thread that just stops reads as a peer that went silent. */
  paused?: boolean;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
}

/**
 * A pair conversation as a plain two-agent chat (PR 5b): THIS agent's
 * messages dark on the right (the same bubble a person's messages get in
 * the direct chat), the peer's white on the left. No tool rows, no
 * narration, no notices - `pairBubbles` decides what is a message; this
 * component only draws. Same scroller and scroll-up history as the direct
 * thread, so a long exchange reads the same way. Read-only by shape: there
 * is no composer, the agents write this thread.
 *
 * Peer tasks (the PR after 5b) add two quiet marks, both from the
 * platform's stamps: "For a person" over an own bubble that opened a task,
 * and the dialog's closing line when a task ends (reported back, or why
 * not). The report itself is not here: it went to the person.
 *
 * Purely presentational, like `ChatThread`, which stays untouched: the
 * direct chat keeps its full transcript, this view is the pair's.
 */
export const PairThread = ({
  agentName,
  peerName,
  turns,
  folded,
  paused = false,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
}: PairThreadProps) => {
  const bubbles = pairBubbles(turns, folded);
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <FollowingViewport>
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-3 px-4 py-6">
            {onLoadOlder !== undefined && (
              <LoadOlderSentinel
                hasOlder={hasOlder}
                loading={loadingOlder}
                onLoadOlder={onLoadOlder}
              />
            )}
            {bubbles.length === 0 && (
              <p className="text-muted-foreground py-8 text-center text-sm">
                No messages yet.
              </p>
            )}
            {bubbles.map((bubble) => (
              <MessageScrollerItem key={bubble.key} messageId={bubble.key}>
                {bubble.kind === "own" ? (
                  <Message
                    align="end"
                    role="group"
                    aria-label={`${agentName} said`}
                  >
                    <MessageContent>
                      {bubble.forPerson && (
                        <span className="text-muted-foreground self-end text-xs">
                          For a person
                        </span>
                      )}
                      <Bubble align="end">
                        <TextBubbleContent text={bubble.text} />
                      </Bubble>
                    </MessageContent>
                  </Message>
                ) : bubble.kind === "task_closed" ? (
                  <p
                    role="status"
                    className="text-muted-foreground text-center text-xs text-pretty"
                  >
                    {taskClosedLine(bubble.outcome)}
                  </p>
                ) : bubble.kind === "peer" ? (
                  <Message role="group" aria-label={`${peerName} said`}>
                    <MessageContent>
                      <Bubble variant="outline">
                        <TextBubbleContent text={bubble.text} />
                      </Bubble>
                    </MessageContent>
                  </Message>
                ) : (
                  <p
                    role="status"
                    className="text-muted-foreground text-center text-xs text-pretty"
                  >
                    <span translate="no">{agentName}</span> couldn’t answer.
                  </p>
                )}
              </MessageScrollerItem>
            ))}
            {paused && (
              <MessageScrollerItem messageId="paused">
                <p
                  role="status"
                  className="text-muted-foreground text-center text-xs text-pretty"
                >
                  Paused. Resume from the contact’s menu to continue.
                </p>
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </FollowingViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
};
