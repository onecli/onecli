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
import type { AgentContact } from "@/lib/api";
import { useDeleteContact } from "@/hooks/use-channels";
import { ContactRowFrame } from "./contact-row-frame";
import { OutboundControl } from "./outbound-control";

interface ContactRowProps {
  agentId: string;
  agentName: string;
  contact: AgentContact;
}

/**
 * One OUTBOUND-only row: an app the agent messaged. An app has no inbound
 * setting of its own (in a channel it follows the channel's), so it has
 * one half; people and channels use the two-way row instead. The badge
 * says whether the agent may message it without asking; the `…` holds
 * Remove.
 */
export const ContactRow = ({
  agentId,
  agentName,
  contact,
}: ContactRowProps) => {
  const remove = useDeleteContact(agentId);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const busy = remove.isPending && remove.variables === contact.id;

  const confirmRemove = () =>
    remove.mutate(contact.id, {
      onSuccess: () => {
        setConfirmOpen(false);
        toast.success(`${contact.displayName} removed`);
      },
      onError: (err) => {
        setConfirmOpen(false);
        toast.error(err instanceof Error ? err.message : "Remove failed");
      },
    });

  return (
    <>
      <ContactRowFrame
        label={contact.displayName}
        disabled={busy}
        onRemove={() => setConfirmOpen(true)}
        status={
          <OutboundControl
            agentId={agentId}
            agentName={agentName}
            subject={contact.displayName}
            contact={contact}
          />
        }
      />

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-pretty">
              Remove <span translate="no">{contact.displayName}</span>?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              The agent will ask you again before messaging them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                confirmRemove();
              }}
              disabled={remove.isPending}
              className={buttonVariants({ variant: "destructive" })}
            >
              {remove.isPending ? (
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
