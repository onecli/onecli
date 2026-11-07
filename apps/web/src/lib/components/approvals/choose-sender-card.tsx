"use client";

import { RequestedAtLabel } from "./requested-at-label";
import { NotSentUndo } from "./not-sent-undo";
import { useUndoableDismiss } from "./use-undoable-dismiss";
import { Send } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { useDecideChannelAction } from "@/hooks/use-approvals";
import type {
  ChooseSenderView,
  PendingActionApprovalItem,
} from "@/lib/api/channel-approvals";

export interface ChooseSenderCardProps {
  item: PendingActionApprovalItem & { chooseSender: ChooseSenderView };
}

/**
 * "How should <Agent> message <Name>?": one question per person. The pick
 * sends the previewed message and changes the real setting in Contacts
 * (Can talk with, or writing as you). Don't send sends nothing.
 */
export const ChooseSenderCard = ({ item }: ChooseSenderCardProps) => {
  const decide = useDecideChannelAction(item.agentId);
  const { recipientLabel, text, agentName } = item.chooseSender;
  const { dismissed, dismiss, undo } = useUndoableDismiss(() =>
    decide.mutate({ approvalId: item.id, decision: "reject" }),
  );
  if (dismissed) return <NotSentUndo onUndo={undo} />;

  const pick = (choice: "agent" | "you") =>
    decide.mutate({ approvalId: item.id, decision: "approve", choice });
  /** The pick in flight shows the spinner; every button waits on it. */
  const picking = (choice: "agent" | "you") =>
    decide.isPending && decide.variables?.choice === choice;

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="bg-muted flex size-7 shrink-0 items-center justify-center rounded-md border dark:border-white/10 dark:bg-white/10">
          <Send className="size-3.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-pretty">
            How should <span translate="no">{agentName}</span> message{" "}
            <span translate="no">{recipientLabel}</span>?
          </p>
          <p className="text-sm text-pretty">“{text}”</p>
          <p className="text-muted-foreground text-xs">
            Saved for <span translate="no">{recipientLabel}</span>. You can
            change it in Contacts.
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
          variant="outline"
          size="xs"
          onClick={() => pick("you")}
          disabled={decide.isPending}
          loading={picking("you")}
        >
          {picking("you") ? "Sending…" : "As me"}
        </Button>
        <Button
          size="xs"
          onClick={() => pick("agent")}
          disabled={decide.isPending}
          loading={picking("agent")}
        >
          {picking("agent") ? (
            "Sending…"
          ) : (
            <>
              As <span translate="no">{agentName}</span>
            </>
          )}
        </Button>
      </div>
    </div>
  );
};
