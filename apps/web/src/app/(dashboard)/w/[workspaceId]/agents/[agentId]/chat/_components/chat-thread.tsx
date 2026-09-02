"use client";

import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
} from "@onecli/ui/components/message-scroller";
import type { Turn } from "@/lib/api/types";
import type { OutgoingMessage } from "@/hooks/use-conversations";
import type { RenderedTurn } from "@/lib/chat/transcript";
import { isFollowUpRow } from "@/lib/chat/turns";
import { useApprovalCards, type ApprovalCard } from "./use-approval-cards";
import { FollowingViewport } from "./following-viewport";
import { InlineApprovalItem } from "./inline-approval-item";
import { TurnBlock } from "./turn-block";
import { UserBubble } from "./user-bubble";

/**
 * The conversation as the reader sees it. Purely presentational: turns give
 * the order and the user side; the folded transcript gives the agent side.
 *
 * Mid-run follow-ups (`joining`/`joined` rows) render WITH their target turn
 * — between its user bubble and its agent block — so the answer that covers
 * them is the LAST thing in the exchange, not something their bubbles dangle
 * under looking unanswered. A follow-up whose target isn't in the list (a
 * pathological orphan) falls back to its own row so it is never invisible.
 */
interface ChatThreadProps {
  turns: Turn[];
  folded: ReadonlyMap<string, RenderedTurn>;
  /** The optimistic user message riding the send/refetch seam — text plus
   *  the staged attachments' local previews. */
  pending?: OutgoingMessage;
  /** Where the pending row's attachment chips resolve their blobs. */
  conversationId: string;
  /** Where a "connect a model key" notice points. */
  modelsHref?: string;
  /** In-place add-key door for the no_model_key notice. */
  onConnectModelKey?: () => void;
}

export const ChatThread = ({
  turns,
  folded,
  pending,
  conversationId,
  modelsHref,
  onConnectModelKey,
}: ChatThreadProps) => {
  const targetIds = new Set(turns.map((turn) => turn.id));
  const followUpsByTarget = new Map<string, Turn[]>();
  for (const turn of turns) {
    if (!isFollowUpRow(turn) || !turn.followUpOfTurnId) continue;
    if (!targetIds.has(turn.followUpOfTurnId)) continue; // orphan → own row
    const group = followUpsByTarget.get(turn.followUpOfTurnId) ?? [];
    group.push(turn);
    followUpsByTarget.set(turn.followUpOfTurnId, group);
  }
  const grouped = new Set(
    [...followUpsByTarget.values()].flat().map((turn) => turn.id),
  );

  // Approval cards ride the timeline like messages: each is slotted after
  // the last turn that PRECEDES its creation, so the card sits where it
  // fired and stays there as the conversation moves on — exactly the Slack
  // reading. Cards newer than every turn land at the end.
  const approvalCards = useApprovalCards();
  const rows = turns.filter((turn) => !grouped.has(turn.id));
  const cardsAfterTurn = new Map<string, ApprovalCard[]>();
  const cardsAtEnd: ApprovalCard[] = [];
  for (const card of approvalCards) {
    let homeId: string | undefined;
    for (const turn of rows) {
      if (new Date(turn.createdAt).getTime() <= card.at) homeId = turn.id;
      else break;
    }
    if (homeId === rows[rows.length - 1]?.id || homeId === undefined) {
      // Newest slot (or an empty thread) — keep it after the final turn so
      // it never renders above the exchange that raised it.
      cardsAtEnd.push(card);
    } else {
      const group = cardsAfterTurn.get(homeId) ?? [];
      group.push(card);
      cardsAfterTurn.set(homeId, group);
    }
  }

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        {/* The follow-preserving viewport, not the stock one: upstream releases
            auto-follow on any gesture at the clamped bottom (shadcn-ui/ui#11224).
            Swap back once that fix ships. */}
        <FollowingViewport>
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6">
            {rows.map((turn) => (
              <MessageScrollerItem
                key={turn.id}
                messageId={turn.id}
                // The thread's gap-6 only separates ITEMS; inside one item
                // the user bubble, its follow-ups, the agent block and any
                // approval cards are siblings and would touch without this.
                className="flex flex-col gap-3"
              >
                <TurnBlock
                  turn={turn}
                  rendered={folded.get(turn.id)}
                  followUps={followUpsByTarget.get(turn.id)}
                  modelsHref={modelsHref}
                  onConnectModelKey={onConnectModelKey}
                />
                {cardsAfterTurn.get(turn.id)?.map(({ approval, settled }) => (
                  <InlineApprovalItem
                    key={approval.id}
                    approval={approval}
                    settled={settled}
                  />
                ))}
              </MessageScrollerItem>
            ))}
            {pending !== undefined && (
              <MessageScrollerItem messageId="pending">
                <UserBubble
                  text={pending.message}
                  conversationId={conversationId}
                  attachments={pending.attachments}
                />
              </MessageScrollerItem>
            )}
            {/* Cards newer than every turn — including ones raised by a
                background watch/cron with no turn running at all. */}
            {cardsAtEnd.length > 0 && (
              <MessageScrollerItem messageId="approvals">
                <div className="flex flex-col gap-3">
                  {cardsAtEnd.map(({ approval, settled }) => (
                    <InlineApprovalItem
                      key={approval.id}
                      approval={approval}
                      settled={settled}
                    />
                  ))}
                </div>
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </FollowingViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
};
