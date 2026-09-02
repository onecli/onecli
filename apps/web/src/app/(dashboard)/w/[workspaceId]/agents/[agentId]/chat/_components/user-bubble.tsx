"use client";

import { Bubble, BubbleContent } from "@onecli/ui/components/bubble";
import { Message, MessageContent } from "@onecli/ui/components/message";
import type { AttachmentMeta } from "@/lib/api/types";
import { AttachmentChips } from "./attachment-chips";

/**
 * The user's side of a turn — one definition, because the optimistic pending
 * row and the settled row are on screen at the same moment and must not
 * drift apart visually.
 *
 * `origin` is the quiet provenance chip ("via Slack") for turns that entered
 * through another door; the optimistic pending row never passes it — a
 * message typed here is by definition from the web. `hint` is the quiet
 * status line under a mid-run follow-up ("Received, folding it in") — same
 * visual register as the chip, joined with it when both apply.
 *
 * `attachments` render under the bubble (or alone, for a file-only message —
 * an empty bubble would read as a glitch); the optimistic row passes local
 * object URLs, the settled row's chips fetch through the blob endpoint.
 */
export const UserBubble = ({
  text,
  origin,
  hint,
  conversationId,
  attachments,
}: {
  text: string;
  origin?: string;
  hint?: string;
  conversationId?: string;
  attachments?: (AttachmentMeta & { objectUrl?: string })[];
}) => (
  <Message align="end">
    <MessageContent>
      {text.length > 0 && (
        <Bubble align="end">
          <BubbleContent className="text-sm break-words whitespace-pre-wrap">
            {text}
          </BubbleContent>
        </Bubble>
      )}
      {conversationId && attachments && attachments.length > 0 && (
        <AttachmentChips
          conversationId={conversationId}
          attachments={attachments}
        />
      )}
      {(origin || hint) && (
        <span className="text-muted-foreground self-end text-xs">
          {[origin, hint].filter(Boolean).join(" · ")}
        </span>
      )}
    </MessageContent>
  </Message>
);
