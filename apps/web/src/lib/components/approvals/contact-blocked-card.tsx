"use client";

import { RequestedAtLabel } from "./requested-at-label";
import { NotSentUndo } from "./not-sent-undo";
import { useUndoableDismiss } from "./use-undoable-dismiss";
import { Ban } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { useDecideChannelAction } from "@/hooks/use-approvals";
import type {
  ContactBlockedView,
  PendingActionApprovalItem,
} from "@/lib/api/channel-approvals";

export interface ContactBlockedCardProps {
  item: PendingActionApprovalItem & { contactBlocked: ContactBlockedView };
}

/**
 * "Let <Agent> message <Name>?" for a contact set to Never. Allow sets Can
 * talk with to Always allow (visible in Contacts) and sends; Don't send
 * sends nothing. The words are the server's summary.
 */
export const ContactBlockedCard = ({ item }: ContactBlockedCardProps) => {
  const decide = useDecideChannelAction(item.agentId);
  const { dismissed, dismiss, undo } = useUndoableDismiss(() =>
    decide.mutate({ approvalId: item.id, decision: "reject" }),
  );
  if (dismissed) return <NotSentUndo onUndo={undo} />;
  const allowing = decide.isPending && decide.variables?.choice === "allow";

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="bg-muted flex size-7 shrink-0 items-center justify-center rounded-md border dark:border-white/10 dark:bg-white/10">
          <Ban className="size-3.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-pretty">{item.summary}</p>
          <p className="text-muted-foreground text-xs">
            Saved for{" "}
            <span translate="no">{item.contactBlocked.recipientLabel}</span>.
            You can change it in Contacts.
          </p>
        </div>
        <RequestedAtLabel createdAt={item.createdAt} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="link"
          size="xs"
          className="text-muted-foreground mr-auto px-0"
          onClick={dismiss}
          disabled={decide.isPending}
        >
          Don&apos;t send
        </Button>
        <Button
          size="xs"
          onClick={() =>
            decide.mutate({
              approvalId: item.id,
              decision: "approve",
              choice: "allow",
            })
          }
          disabled={decide.isPending}
          loading={allowing}
        >
          {allowing ? "Allowing…" : "Allow"}
        </Button>
      </div>
    </div>
  );
};
