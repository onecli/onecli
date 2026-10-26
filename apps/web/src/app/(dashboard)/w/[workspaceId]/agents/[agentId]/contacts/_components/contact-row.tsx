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

  // Instant: the row leaves and the confirm closes on click. The hook puts
  // the row back and says why if the server refuses; this confirms once it
  // agrees (the row is gone, so the call-site callback still fires).
  const confirmRemove = () => {
    setConfirmOpen(false);
    remove
      .mutateAsync(contact.id)
      .then(() => toast.success(`${contact.displayName} removed`))
      .catch(() => undefined);
  };

  return (
    <>
      <ContactRowFrame
        label={contact.displayName}
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
    </>
  );
};
