"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import type { PendingReachAskItem } from "@/lib/api/channel-approvals";
import { useDecideChannelReach } from "@/hooks/use-approvals";
import { formatAge } from "./format-age";

interface ReachAskRowProps {
  item: PendingReachAskItem;
}

/**
 * One pending reach ask in the bell — THE decide surface for these. A space
 * (channel) settles three ways; a person settles two. The decisions post to
 * the existing per-agent reach doors; labels match the Slack card's own
 * vocabulary so the two surfaces read as one decision.
 */
export const ReachAskRow = ({ item }: ReachAskRowProps) => {
  const decide = useDecideChannelReach(item.agentId, item.provider);
  const [choosing, setChoosing] = useState<string | null>(null);

  const subject =
    item.subjectLabel ??
    (item.subjectKind === "space" ? "a channel" : "someone");
  const isSpace = item.subjectKind === "space";

  const submit = (state: "approved" | "members_only" | "blocked") => {
    setChoosing(state);
    decide.mutate(
      {
        externalRef: item.externalRef,
        subjectKind: item.subjectKind,
        state,
      },
      {
        onSuccess: () =>
          toast.success(
            state === "approved"
              ? isSpace
                ? `${item.agentName} answers everyone in ${subject}`
                : `${subject} can talk to ${item.agentName}`
              : state === "blocked"
                ? isSpace
                  ? `${item.agentName} stays silent in ${subject}`
                  : `${subject} is blocked`
                : "OneCLI teammates only",
          ),
        onError: (err) => toast.error(String(err)),
        onSettled: () => setChoosing(null),
      },
    );
  };

  const pending = decide.isPending;
  const choiceButton = (
    state: "approved" | "members_only" | "blocked",
    label: string,
  ) => (
    <Button
      variant={state === "approved" ? "default" : "outline"}
      size="xs"
      disabled={pending}
      onClick={() => submit(state)}
    >
      {pending && choosing === state ? (
        <Loader2
          aria-hidden="true"
          className="size-3 animate-spin motion-reduce:hidden"
        />
      ) : (
        label
      )}
    </Button>
  );

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {isSpace
              ? `${item.agentName} was added to ${subject}`
              : `${subject} wants to talk to ${item.agentName}`}
          </p>
          <p className="text-muted-foreground truncate text-xs">
            {isSpace
              ? "Who should it answer there?"
              : "They are not a OneCLI teammate."}
          </p>
        </div>
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {formatAge(item.createdAt)}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {isSpace ? (
          <>
            {choiceButton("blocked", "Nobody")}
            {choiceButton("members_only", "Teammates only")}
            {choiceButton("approved", "Everyone")}
          </>
        ) : (
          <>
            {choiceButton("blocked", "Block")}
            {choiceButton("approved", "Allow")}
          </>
        )}
      </div>
    </div>
  );
};
