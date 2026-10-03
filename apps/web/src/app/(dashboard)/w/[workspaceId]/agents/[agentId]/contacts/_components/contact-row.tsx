"use client";

import { useState } from "react";
import {
  Check,
  ChevronDown,
  Loader2,
  ShieldCheck,
  Slash,
  UserCheck,
} from "lucide-react";
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
import { Badge } from "@onecli/ui/components/badge";
import { Button, buttonVariants } from "@onecli/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import type { AgentContact } from "@/lib/api";
import { useDeleteContact, useSetContactPolicy } from "@/hooks/use-channels";
import { ContactRowFrame } from "./contact-row-frame";

interface ContactRowProps {
  agentId: string;
  contact: AgentContact;
}

type Policy = AgentContact["policy"];

/** One policy's face: the badge word, its tone, and the menu line. */
const POLICIES: Record<
  Policy,
  {
    badge: string;
    badgeClass: string;
    Icon: typeof Check;
    menu: string;
    hint: string;
    toast: string;
  }
> = {
  allow: {
    badge: "Always allowed",
    badgeClass:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    Icon: UserCheck,
    menu: "Always allow",
    hint: "No approval needed.",
    toast: "always allowed",
  },
  ask: {
    badge: "Asks first",
    badgeClass: "",
    Icon: ShieldCheck,
    menu: "Ask me first",
    hint: "You approve each message.",
    toast: "asks first",
  },
  blocked: {
    badge: "Blocked",
    badgeClass:
      "border-destructive/30 bg-destructive/10 text-destructive dark:text-red-400",
    Icon: Slash,
    menu: "Block",
    hint: "No messages, no mentions.",
    toast: "blocked",
  },
};

const ORDER: readonly Policy[] = ["allow", "ask", "blocked"];

/**
 * One row of the agent's OUTBOUND address book: someone the agent messaged
 * on its own with send_message, and the standing decision that send left
 * behind. The same shape as every other Contacts row (the shared frame):
 * the badge is the reading and, pressed, offers the other two words; the
 * `…` holds Remove. The kind (person / channel / app) is said by the group
 * the row sits in, never repeated per row.
 */
export const ContactRow = ({ agentId, contact }: ContactRowProps) => {
  const setPolicy = useSetContactPolicy(agentId);
  const remove = useDeleteContact(agentId);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const mine = POLICIES[contact.policy];
  const busy =
    (setPolicy.isPending && setPolicy.variables?.contactId === contact.id) ||
    (remove.isPending && remove.variables === contact.id);

  const choose = (policy: Policy) => {
    if (policy === contact.policy) return;
    setPolicy.mutate(
      { contactId: contact.id, policy },
      {
        onSuccess: () =>
          toast.success(`${contact.displayName}: ${POLICIES[policy].toast}`),
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : "Update failed"),
      },
    );
  };

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
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={busy}>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 px-2"
                aria-label={`Whether the agent may message ${contact.displayName} on its own: ${mine.badge.toLowerCase()}. Change`}
              >
                {setPolicy.isPending &&
                setPolicy.variables?.contactId === contact.id ? (
                  <Loader2
                    className="size-3.5 animate-spin motion-reduce:hidden"
                    aria-hidden
                  />
                ) : null}
                <Badge variant="secondary" className={mine.badgeClass}>
                  <mine.Icon className="size-3" aria-hidden />
                  {mine.badge}
                </Badge>
                <ChevronDown
                  className="text-muted-foreground size-3.5"
                  aria-hidden
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuLabel className="font-normal text-pretty">
                Message <span translate="no">{contact.displayName}</span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {ORDER.map((policy) => (
                <DropdownMenuItem
                  key={policy}
                  onSelect={() => choose(policy)}
                  className="items-start gap-2"
                >
                  <Check
                    className={`mt-0.5 size-3.5 shrink-0 ${contact.policy === policy ? "" : "invisible"}`}
                    aria-hidden
                  />
                  <span className="min-w-0">
                    <span className="block text-sm">
                      {POLICIES[policy].menu}
                    </span>
                    <span className="text-muted-foreground block text-xs text-pretty">
                      {POLICIES[policy].hint}
                    </span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
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
