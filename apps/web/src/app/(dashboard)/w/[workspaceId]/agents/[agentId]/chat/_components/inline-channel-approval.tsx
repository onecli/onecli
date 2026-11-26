"use client";

import { Message, MessageContent } from "@onecli/ui/components/message";
import { ActionApprovalRow } from "@/lib/components/approvals/action-approval-row";
import { ReachAskRow } from "@/lib/components/approvals/reach-ask-row";
import type { PendingChannelApprovalItem } from "@/lib/api/channel-approvals";

interface InlineChannelApprovalProps {
  item: PendingChannelApprovalItem;
}

/**
 * A pending channel approval inside the agent's chat - the web twin of the
 * Slack DM card. The bell's own row, framed as a message: same decide door,
 * same answers (an action's Approve / Reject or Always allow / Never, a
 * reach ask's choices). It leaves the thread once decided, like the bell
 * row.
 */
export const InlineChannelApproval = ({ item }: InlineChannelApprovalProps) => (
  <Message align="start">
    <MessageContent>
      {/* The gateway inline card's frame, so both kinds read as one family. */}
      <div className="bg-muted/50 w-full max-w-[80%] overflow-hidden rounded-xl border">
        {item.kind === "reach" ? (
          <ReachAskRow item={item} />
        ) : (
          <ActionApprovalRow item={item} />
        )}
      </div>
    </MessageContent>
  </Message>
);
