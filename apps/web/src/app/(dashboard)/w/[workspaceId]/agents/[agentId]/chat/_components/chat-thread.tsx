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
import { ApprovalTimelineSlot } from "./approval-timeline-slot";
import { useApprovalTimeline } from "./approval-timeline";
import { useApprovalCards } from "./use-approval-cards";
import { useActionApprovalCards } from "./use-action-approval-cards";
import { InlineActionApproval } from "./inline-action-approval";
import { slotAfterTurns } from "./slot-after-turns";
import { EmptyThreadWelcome } from "./empty-thread-welcome";
import { FollowingViewport } from "./following-viewport";
import { LoadOlderSentinel } from "./load-older-sentinel";
import { TurnBlock } from "./turn-block";
import { UserBubble } from "./user-bubble";

/**
 * The conversation as the reader sees it. Purely presentational: turns give
 * the order and the user side; the folded transcript gives the agent side.
 *
 * Mid-run follow-ups (`joining`/`joined` rows) render WITH their target turn,
 * between its user bubble and its agent block, each followed by the agent's
 * reply to it when it wrote one. So the answer that covers the rest is the
 * LAST thing in the exchange, not something their bubbles dangle under
 * looking unanswered. A follow-up whose target isn't in the list (a
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
  /** The agent's display name, for the empty-thread welcome. */
  agentName?: string;
  /** The agent whose thread this is — the welcome reads its model state. */
  agentId?: string;
  /** In-place add-key door for the no_model_key notice. */
  onConnectModelKey?: () => void;
  /** Older windows exist above what's loaded — mount the scroll-up loader. */
  hasOlder?: boolean;
  /** An older window is in flight — its skeleton row shows at the top. */
  loadingOlder?: boolean;
  /** Ask for the next older window (the top sentinel's trigger). */
  onLoadOlder?: () => void;
}

export const ChatThread = ({
  turns,
  folded,
  pending,
  conversationId,
  modelsHref,
  agentName,
  agentId,
  onConnectModelKey,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
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
  // What the transcript holds under a follow-up's own id: the agent's
  // reply to it, streaming while the run writes it and stored once it is
  // handed over (the reply lives under the follow-up's row, like any
  // turn's answer).
  const followUpRendered = (followUpId: string) => folded.get(followUpId);

  // Approval cards ride the timeline like messages: each is slotted after
  // the last turn that PRECEDES its creation, so the card sits where it
  // fired and stays there as the conversation moves on — exactly the Slack
  // reading. Cards newer than every turn land at the end.
  const rows = turns.filter((turn) => !grouped.has(turn.id));
  const cards = slotAfterTurns(rows, useApprovalTimeline(useApprovalCards()));
  const actions = slotAfterTurns(
    rows,
    useActionApprovalCards(agentId, conversationId),
  );

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        {/* The follow-preserving viewport, not the stock one: upstream releases
            auto-follow on any gesture at the clamped bottom (shadcn-ui/ui#11224).
            Swap back once that fix ships. */}
        <FollowingViewport>
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6">
            {/* The scroll-up loader. Prepended pages hold the reading
                position via the viewport's own preserveScrollOnPrepend
                (default on) — the reader never feels the seam. */}
            {onLoadOlder !== undefined && (
              <LoadOlderSentinel
                hasOlder={hasOlder}
                loading={loadingOlder}
                onLoadOlder={onLoadOlder}
              />
            )}
            {/* Nothing has been said here yet — and nothing is on its way
                either (a greeting in flight is already a row). The agent
                speaks first only in the thread with the agent onboarding
                created; every other new thread — an agent made later from
                the dashboard, or one whose account has no model key yet —
                opens here, in the product's own voice. */}
            {rows.length === 0 &&
              pending === undefined &&
              agentName !== undefined &&
              agentId !== undefined && (
                <MessageScrollerItem messageId="empty-welcome">
                  <EmptyThreadWelcome agentId={agentId} agentName={agentName} />
                </MessageScrollerItem>
              )}
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
                  followUpRendered={followUpRendered}
                  modelsHref={modelsHref}
                  onConnectModelKey={onConnectModelKey}
                />
                <ApprovalTimelineSlot
                  entries={cards.afterTurn.get(turn.id) ?? []}
                />
                {actions.afterTurn.get(turn.id)?.map((card) => (
                  <InlineActionApproval key={card.item.id} item={card.item} />
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
            {(cards.atEnd.length > 0 || actions.atEnd.length > 0) && (
              <MessageScrollerItem messageId="approvals">
                <div className="flex flex-col gap-3">
                  <ApprovalTimelineSlot entries={cards.atEnd} />
                  {actions.atEnd.map((card) => (
                    <InlineActionApproval key={card.item.id} item={card.item} />
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
