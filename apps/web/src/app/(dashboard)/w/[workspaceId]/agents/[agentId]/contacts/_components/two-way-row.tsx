"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
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
import {
  useDeleteContact,
  useDismissPersonReach,
  useDismissReachRow,
} from "@/hooks/use-channels";
import { ContactRowFrame } from "./contact-row-frame";
import { DirectionCell } from "./direction-cell";
import { InboundPersonControl } from "./inbound-person-control";
import { InboundSpaceControl } from "./inbound-space-control";
import { namesOf, type MergedEntry } from "./merge-contacts";
import { OutboundControl } from "./outbound-control";

export type TwoWayRowProps =
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
    };

/** What Remove clears, said per direction so a one-sided remove never
 *  reads as clearing both. */
const removeDescription = (
  kind: "person" | "channel",
  agentName: string,
  clears: { inbound: boolean; outbound: boolean },
): string => {
  if (clears.inbound && clears.outbound) {
    return "Clears both settings. The next message either way will ask you again.";
  }
  if (clears.inbound) {
    return kind === "person"
      ? `Clears whether they can message ${agentName}. If they message again, you will be asked again.`
      : `Clears who ${agentName} answers here. The next message there will ask you again.`;
  }
  return kind === "person"
    ? `Clears whether ${agentName} can message them on its own. Its next message to them will ask you first.`
    : `Clears whether ${agentName} can post here on its own. Its next post will ask you first.`;
};

/** The two column questions, per kind. Shared with the group's header. */
export const directionHeadings = (
  kind: "person" | "channel",
  agentName: string,
): { inbound: string; outbound: string } =>
  kind === "person"
    ? {
        inbound: `Can message ${agentName}`,
        outbound: `${agentName} can message them`,
      }
    : {
        inbound: `${agentName} answers`,
        outbound: `${agentName} can post`,
      };

/**
 * One person or channel, BOTH directions on one row: the inbound question
 * (they write to the agent: does it answer?) and the outbound one (may the
 * agent write to them on its own?). The two halves are separate records on
 * the server; the row only composes them, each control driving its own
 * existing mutation. Remove clears whichever halves exist, so the next
 * message either way asks you again.
 */
export const TwoWayRow = (props: TwoWayRowProps) => {
  const { kind, agentId, agentName, entry } = props;
  const provider = entry.reach?.provider ?? "slack";
  const dismissPerson = useDismissPersonReach(agentId, provider);
  const dismissSpace = useDismissReachRow(agentId, provider);
  const deleteContact = useDeleteContact(agentId);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const { title, subtitle } = namesOf(entry);
  const headings = directionHeadings(kind, agentName);
  // A PENDING reach row is an open ask in the bell, not a setting: Remove
  // never dismisses it (the old pending rows had no menu at all), so the
  // bell keeps the one place it is decided.
  const reachRef =
    entry.reach && entry.reach.value.state !== "pending"
      ? entry.reach.value.externalRef
      : null;
  const removable = reachRef !== null || entry.contact !== null;

  const confirmRemove = async () => {
    setRemoving(true);
    // Two independent records: settle both, so one failing never hides
    // that the other was cleared (each hook invalidates its own query).
    const results = await Promise.allSettled([
      reachRef
        ? (kind === "person" ? dismissPerson : dismissSpace).mutateAsync({
            externalRef: reachRef,
          })
        : null,
      entry.contact ? deleteContact.mutateAsync(entry.contact.id) : null,
    ]);
    const failed = results.find(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (failed) {
      toast.error(
        failed.reason instanceof Error
          ? failed.reason.message
          : "Remove failed",
      );
    } else {
      toast.success(`${title} removed`);
    }
    setRemoving(false);
    setConfirmOpen(false);
  };

  return (
    <>
      <ContactRowFrame
        label={title}
        subtitle={subtitle}
        mono={kind === "channel"}
        disabled={removing}
        {...(removable && { onRemove: () => setConfirmOpen(true) })}
        status={
          <div className="flex items-center gap-1 sm:gap-2">
            <DirectionCell heading={headings.inbound}>
              {props.kind === "person" ? (
                <InboundPersonControl
                  agentId={agentId}
                  agentName={agentName}
                  subject={title}
                  reach={props.entry.reach}
                />
              ) : (
                <InboundSpaceControl
                  agentId={agentId}
                  agentName={agentName}
                  subject={title}
                  reach={props.entry.reach}
                />
              )}
            </DirectionCell>
            <DirectionCell heading={headings.outbound}>
              <OutboundControl
                agentId={agentId}
                agentName={agentName}
                subject={title}
                contact={entry.contact}
              />
            </DirectionCell>
          </div>
        }
      />

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-pretty">
              Remove <span translate="no">{title}</span>?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              {removeDescription(kind, agentName, {
                inbound: reachRef !== null,
                outbound: entry.contact !== null,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                // Keep the dialog open while the request runs; close on
                // settle so the outcome toast is the next thing seen.
                event.preventDefault();
                void confirmRemove();
              }}
              disabled={removing}
              className={buttonVariants({ variant: "destructive" })}
            >
              {removing ? (
                <>
                  <Loader2
                    className="size-3.5 animate-spin motion-reduce:hidden"
                    aria-hidden
                  />
                  Removing…
                </>
              ) : (
                "Remove"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
