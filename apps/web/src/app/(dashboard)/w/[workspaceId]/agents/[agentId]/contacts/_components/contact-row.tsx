"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@onecli/ui/components/alert-dialog";
import { buttonVariants } from "@onecli/ui/components/button";
import type { ChannelPersonReach, ChannelSpaceReach } from "@/lib/api";
import { Undo2 } from "lucide-react";
import {
  useDismissPersonReach,
  useDismissReachRow,
  useForgetSendAsPreference,
  useSendAsPreferences,
} from "@/hooks/use-channels";
import type { ActAsYouRowExtras } from "./act-as-you-slot";
import { ChannelControl } from "./channel-control";
import { ChannelListenControl } from "./channel-listen-control";
import { ContactRowFrame } from "./contact-row-frame";
import { nameOf, type MergedEntry } from "./merge-contacts";
import { PersonAvatar } from "./person-avatar";
import { PersonControl } from "./person-control";

type ContactRowBase = {
  /** What "acts as you" adds (licensed); absent = nothing. */
  extras?: ActAsYouRowExtras | null;
};

export type ContactRowProps = ContactRowBase &
  (
    | {
        kind: "person";
        agentId: string;
        agentName: string;
        entry: MergedEntry<ChannelPersonReach>;
      }
    | {
        kind: "channel";
        agentId: string;
        agentName: string;
        entry: MergedEntry<ChannelSpaceReach>;
      }
  );

/** What Remove clears: the row's one setting. */
const removeDescription = (
  kind: "person" | "channel",
  agentName: string,
): string => {
  if (kind === "channel") {
    // Remove forgets the setting only: the bot cannot leave a channel on its
    // own (no channels:manage scope), so say where removal really happens.
    return `Clears what ${agentName} replies to here. The next message there will ask you again. ${agentName} stays in the channel. Remove it in Slack to take it out.`;
  }
  return `Clears their setting. Their next DM, and ${agentName}'s next message to them, will ask you again.`;
};

/**
 * One person or channel and its ONE setting. Remove clears that setting, so
 * the next message either way asks you again. A pending row is an open ask
 * in the bell, not a setting, and a workspace owner's row is fixed: neither
 * offers Remove.
 */
export const ContactRow = (props: ContactRowProps) => {
  const { kind, agentId, agentName, entry, extras } = props;
  const { provider, value } = entry.reach;
  const dismissPerson = useDismissPersonReach(agentId, provider);
  const dismissSpace = useDismissReachRow(agentId, provider);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const title = nameOf(entry);
  const isOwner = props.kind === "person" && props.entry.reach.value.isOwner;
  const removable = value.state !== "pending" && !isOwner;
  // The caller's own remembered sender for this recipient (send_message's
  // "send as the agent or as you?"): a quiet label and a Forget item.
  const { data: sendAsPrefs } = useSendAsPreferences(agentId);
  const forgetSendAs = useForgetSendAsPreference(agentId);
  const sendAs = sendAsPrefs?.get(value.externalRef) ?? null;
  const sendAsLabel =
    sendAs === "you"
      ? "sends as you"
      : sendAs === "agent"
        ? `sends as ${agentName}`
        : null;
  const subtitle =
    [isOwner ? "Workspace owner" : null, sendAsLabel]
      .filter(Boolean)
      .join(" · ") || null;
  const actions = [
    ...(extras?.actions ?? []),
    ...(sendAs
      ? [
          {
            label: "Forget send-as choice",
            icon: <Undo2 className="size-4" aria-hidden />,
            onSelect: () =>
              forgetSendAs.mutate(value.externalRef, {
                onSuccess: () =>
                  toast.success(
                    `Forgot who sends to ${title}. The next message asks again.`,
                  ),
                onError: () => toast.error("Couldn't forget the choice"),
              }),
            disabled: forgetSendAs.isPending,
          },
        ]
      : []),
  ];

  // Instant: the row leaves on click and the confirm closes. The hook puts
  // it back (and says why) if the server refuses.
  const confirmRemove = () => {
    setConfirmOpen(false);
    (kind === "person" ? dismissPerson : dismissSpace)
      .mutateAsync({ externalRef: value.externalRef })
      .then(() => toast.success(`${title} removed`))
      .catch(() => undefined);
  };

  return (
    <div>
      <ContactRowFrame
        label={title}
        mono={kind === "channel"}
        {...(props.kind === "person" && {
          leading: (
            <PersonAvatar
              name={title}
              imageUrl={props.entry.reach.value.avatarUrl}
            />
          ),
        })}
        subtitle={subtitle}
        {...(removable && { onRemove: () => setConfirmOpen(true) })}
        actions={actions}
        {...(extras && { asYou: extras.cells })}
        status={
          props.kind === "channel" ? (
            <div className="flex min-w-0 items-center gap-1 sm:gap-2">
              {/* The allow/never icons lead so they line up with person
                  rows; what it replies to follows, only while allowed. */}
              <ChannelControl
                agentId={agentId}
                agentName={agentName}
                subject={title}
                reach={props.entry.reach}
              />
              <ChannelListenControl
                agentId={agentId}
                agentName={agentName}
                subject={title}
                reach={props.entry.reach}
              />
            </div>
          ) : (
            <PersonControl
              agentId={agentId}
              agentName={agentName}
              subject={title}
              reach={props.entry.reach}
            />
          )
        }
      />

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-pretty">
              Remove <span translate="no">{title}</span>?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              {removeDescription(kind, agentName)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmRemove}
              className={buttonVariants({ variant: "destructive" })}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
