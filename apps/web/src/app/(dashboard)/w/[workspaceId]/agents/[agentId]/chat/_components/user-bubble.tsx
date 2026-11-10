"use client";

import { Bubble } from "@onecli/ui/components/bubble";
import { Message, MessageContent } from "@onecli/ui/components/message";
import { cn } from "@onecli/ui/lib/utils";
import type { AttachmentMeta } from "@/lib/api/types";
import { AttachmentChips } from "./attachment-chips";
import { MessageTime, REVEAL_ON_HOVER } from "./message-time";
import { TextBubbleContent } from "./text-bubble-content";

/**
 * The user's side of a turn — one definition, because the optimistic pending
 * row and the settled row are on screen at the same moment and must not
 * drift apart visually.
 *
 * `origin` is the quiet provenance chip ("via Slack") for turns that entered
 * through another door; the optimistic pending row never passes it — a
 * message typed here is by definition from the web. `hint` is the quiet
 * status line under a mid-run follow-up ("Received, folding it in") — same
 * visual register as the chip, joined with it when both apply. `action` is
 * a control on that same line (SEND NOW), after the words.
 *
 * `sentAt` is when the message was sent: shown on hover or focus at the end
 * of the same line (always on touch), in the viewer's own time zone. The
 * pending row has none until the server stamps it.
 *
 * `attachments` render under the bubble (or alone, for a file-only message —
 * an empty bubble would read as a glitch). Both optimistic and settled tiles
 * share authenticated bytes through the same query cache.
 */
export const UserBubble = ({
  text,
  origin,
  hint,
  action,
  sentAt,
  conversationId,
  attachments,
}: {
  text: string;
  origin?: string;
  hint?: string;
  action?: React.ReactNode;
  sentAt?: string;
  conversationId?: string;
  attachments?: AttachmentMeta[];
}) => (
  <Message align="end" className="group/msg">
    <MessageContent>
      {text.length > 0 && (
        <Bubble align="end">
          {/* The answer's size and rhythm, so the two sides of the
              conversation read as one text. */}
          <TextBubbleContent
            text={text}
            className="text-[0.9375rem] leading-[1.6]"
          />
        </Bubble>
      )}
      {conversationId && attachments && attachments.length > 0 && (
        <AttachmentChips
          conversationId={conversationId}
          attachments={attachments}
        />
      )}
      {(origin || hint || action || sentAt) && (
        <span className="text-muted-foreground flex min-h-4 items-center gap-1 self-end text-xs">
          {(origin || hint) && (
            <span>{[origin, hint].filter(Boolean).join(" · ")}</span>
          )}
          {action && (
            // `empty:hidden`: an action may render nothing for now (SEND
            // NOW between tools), and its separator must go with it.
            <span
              className={cn(
                "empty:hidden",
                (origin || hint) && "before:pe-1 before:content-['·']",
              )}
            >
              {action}
            </span>
          )}
          {sentAt && (
            <MessageTime
              at={sentAt}
              className={cn(
                REVEAL_ON_HOVER,
                (origin || hint || action) &&
                  "before:pe-1 before:content-['·']",
              )}
            />
          )}
        </span>
      )}
    </MessageContent>
  </Message>
);
