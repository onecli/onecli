"use client";

import { ChevronRight, ExternalLink } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@onecli/ui/components/collapsible";
import type { ReachDecision } from "@/lib/api/channels";
import type { PendingReachAskItem } from "@/lib/api/channel-approvals";
import { useDecideChannelReach } from "@/hooks/use-approvals";
import { channelProviderUi } from "@/lib/agents/channel-providers/registry";
import { RequestedAtLabel } from "./requested-at-label";

interface ReachAskRowProps {
  item: PendingReachAskItem;
}

/**
 * One pending reach ask in the bell — THE decide surface for these. A space
 * (channel) is on or off; a person gets their one setting, in the app
 * permission words (Always allow, Never). The decisions post to the
 * existing per-agent reach doors; labels match the Slack card's own
 * vocabulary so the two surfaces read as one decision. "Details" unfolds
 * what each answer does, and links a channel when its provider can.
 */
export const ReachAskRow = ({ item }: ReachAskRowProps) => {
  const decide = useDecideChannelReach(item.agentId, item.provider);

  const subject =
    item.subjectLabel ??
    (item.subjectKind === "space" ? "a channel" : "someone");
  const isSpace = item.subjectKind === "space";
  const provider = channelProviderUi(item.provider);
  const channelUrl =
    isSpace && item.tenantExternalId && provider?.channelUrl
      ? provider.channelUrl(item.externalRef, item.tenantExternalId)
      : null;

  // Instant: the ask leaves the bell on click (this row unmounts with it),
  // and the hook says the outcome once the server agrees, or puts the ask
  // back with the reason if it doesn't.
  const submit = (state: ReachDecision) =>
    decide.mutate({
      itemId: item.id,
      externalRef: item.externalRef,
      subjectKind: item.subjectKind,
      state,
      confirmation:
        state === "approved"
          ? isSpace
            ? `${item.agentName} answers everyone in ${subject}`
            : `${subject} can talk to ${item.agentName}`
          : isSpace
            ? `${item.agentName} stays silent in ${subject}`
            : `${subject} is blocked`,
    });

  const choiceButton = (state: ReachDecision, label: string) => (
    <Button
      variant={state === "approved" ? "default" : "outline"}
      size="xs"
      onClick={() => submit(state)}
    >
      {label}
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
        <RequestedAtLabel createdAt={item.createdAt} />
      </div>
      <Collapsible>
        <CollapsibleTrigger className="text-foreground/70 hover:text-foreground focus-visible:ring-ring/50 group flex w-fit items-center gap-1 rounded-sm text-xs transition-colors outline-none focus-visible:ring-[3px]">
          <ChevronRight
            className="text-muted-foreground size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
            aria-hidden
          />
          Details
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="bg-muted/50 text-muted-foreground mt-1.5 space-y-1.5 rounded-md px-3 py-2 text-xs">
            {isSpace ? (
              <>
                <p>
                  Someone added {item.agentName} to{" "}
                  <span className="text-foreground font-medium">{subject}</span>
                  . It stays quiet there until you choose:
                </p>
                <ul className="list-disc space-y-0.5 pl-4">
                  <li>
                    <span className="text-foreground">Everyone</span>: it
                    answers anyone in the channel, and may post there.
                  </li>
                  <li>
                    <span className="text-foreground">Nobody</span>: it stays
                    silent in this channel.
                  </li>
                </ul>
                <p>
                  You can change this later on the agent&apos;s Contacts page.
                </p>
                {channelUrl && provider && (
                  <a
                    href={channelUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-foreground inline-flex items-center gap-1 underline-offset-2 hover:underline"
                  >
                    Open the channel in {provider.name}
                    <ExternalLink className="size-3" aria-hidden />
                  </a>
                )}
              </>
            ) : (
              <>
                <p>
                  <span className="text-foreground font-medium">{subject}</span>{" "}
                  messaged {item.agentName} directly but has no OneCLI account
                  in this workspace, so it hasn&apos;t replied.
                </p>
                <ul className="list-disc space-y-0.5 pl-4">
                  <li>
                    <span className="text-foreground">Always allow</span>: it
                    talks with them, and they get a message saying so.
                  </li>
                  <li>
                    <span className="text-foreground">Never</span>: it never
                    answers them.
                  </li>
                </ul>
              </>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {isSpace ? (
          <>
            {choiceButton("blocked", "Nobody")}
            {choiceButton("approved", "Everyone")}
          </>
        ) : (
          <>
            {choiceButton("blocked", "Never")}
            {choiceButton("approved", "Always allow")}
          </>
        )}
      </div>
    </div>
  );
};
