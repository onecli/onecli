"use client";

import { Message, MessageContent } from "@onecli/ui/components/message";
import { ActionApprovalRow } from "@/lib/components/approvals/action-approval-row";
import type { PendingActionApprovalItem } from "@/lib/api/channel-approvals";

interface InlineActionApprovalProps {
  item: PendingActionApprovalItem;
}

/**
 * A pending action approval inside the agent's chat, where the asking turn
 * ran - the web twin of the Slack DM card. The bell's row, framed as a
 * message: same decide door, same dialogs (details, always allow, reject
 * with a reason). It leaves the thread once decided, like the bell row.
 */
export const InlineActionApproval = ({ item }: InlineActionApprovalProps) => (
  <Message align="start">
    <MessageContent>
      {/* The gateway inline card's frame, so both kinds read as one family. */}
      <div className="bg-muted/50 w-full max-w-[80%] overflow-hidden rounded-xl border">
        <ActionApprovalRow item={item} />
      </div>
    </MessageContent>
  </Message>
);
