"use client";

import { Bot, Hash, Loader2, Trash2, User } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import type { AgentContact } from "@/lib/api";
import {
  useAgentContacts,
  useDeleteContact,
  useSetContactPolicy,
} from "@/hooks/use-channels";

interface ContactsSectionProps {
  agentId: string;
}

/**
 * The agent's outbound address book — send_message's standing decisions.
 * An `allow` row is the "always allow" upgrade (card button or here); the
 * revoke direction is a flip back to `ask` — the next send holds again.
 *
 * Renders nothing while empty: contacts only exist once sends started
 * happening, and an empty governance section reads as a nag.
 */
export const ContactsSection = ({ agentId }: ContactsSectionProps) => {
  const { data } = useAgentContacts(agentId);
  const setPolicy = useSetContactPolicy(agentId);
  const remove = useDeleteContact(agentId);

  const contacts = data?.contacts ?? [];
  if (contacts.length === 0) return null;

  const setTo = (
    contact: AgentContact,
    policy: "ask" | "allow" | "blocked",
  ) => {
    setPolicy.mutate(
      { contactId: contact.id, policy },
      {
        onSuccess: () =>
          toast.success(
            policy === "allow"
              ? `${contact.displayName}: sends without asking`
              : policy === "blocked"
                ? `${contact.displayName}: blocked. No sends, no mentions`
                : `${contact.displayName}: every send asks first`,
          ),
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">Contacts</h2>
        <p className="text-muted-foreground text-xs">
          Who this agent may message on its own. &quot;Always allowed&quot;
          sends go out without asking you first.
        </p>
      </div>
      <ul className="divide-y rounded-md border">
        {contacts.map((contact) => (
          <li
            key={contact.id}
            className="flex items-center gap-3 px-3 py-2 text-sm"
          >
            {contact.kind === "channel" ? (
              <Hash
                aria-hidden="true"
                className="text-muted-foreground size-4 shrink-0"
              />
            ) : contact.kind === "app" ? (
              <Bot
                aria-hidden="true"
                className="text-muted-foreground size-4 shrink-0"
              />
            ) : (
              <User
                aria-hidden="true"
                className="text-muted-foreground size-4 shrink-0"
              />
            )}
            <span className="min-w-0 flex-1 truncate">
              {contact.displayName}
            </span>
            <Badge
              variant={
                contact.policy === "allow"
                  ? "default"
                  : contact.policy === "blocked"
                    ? "destructive"
                    : "secondary"
              }
            >
              {contact.policy === "allow"
                ? "Always allowed"
                : contact.policy === "blocked"
                  ? "Blocked"
                  : "Asks first"}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              disabled={
                setPolicy.isPending &&
                setPolicy.variables?.contactId === contact.id
              }
              onClick={() =>
                setTo(
                  contact,
                  contact.policy === "allow" || contact.policy === "blocked"
                    ? "ask"
                    : "allow",
                )
              }
            >
              {setPolicy.isPending &&
              setPolicy.variables?.contactId === contact.id ? (
                <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              ) : contact.policy === "allow" ? (
                "Require approval"
              ) : contact.policy === "blocked" ? (
                "Unblock"
              ) : (
                "Always allow"
              )}
            </Button>
            {contact.policy !== "blocked" && (
              <Button
                variant="ghost"
                size="sm"
                disabled={
                  setPolicy.isPending &&
                  setPolicy.variables?.contactId === contact.id
                }
                onClick={() => setTo(contact, "blocked")}
              >
                Block
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${contact.displayName}`}
              disabled={remove.isPending && remove.variables === contact.id}
              onClick={() => {
                // Destructive: never immediate (the guideline). The row is
                // governance state - removing it silently would erase who
                // allowed what.
                if (
                  !window.confirm(
                    `Remove ${contact.displayName} from contacts? The agent will ask again on the next message.`,
                  )
                ) {
                  return;
                }
                remove.mutate(contact.id, {
                  onSuccess: () => toast.success("Contact removed"),
                  onError: (err) => toast.error(String(err)),
                });
              }}
            >
              <Trash2 aria-hidden="true" className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
};
