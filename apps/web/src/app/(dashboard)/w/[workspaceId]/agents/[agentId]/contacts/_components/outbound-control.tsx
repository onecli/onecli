"use client";

import {
  Check,
  ChevronDown,
  ShieldCheck,
  Slash,
  UserCheck,
} from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import { cn } from "@onecli/ui/lib/utils";
import type { AgentContact } from "@/lib/api";
import { useSetContactPolicy } from "@/hooks/use-channels";
import { DirectionPlaceholder } from "./direction-placeholder";

type Policy = AgentContact["policy"];

/** One outbound policy's face: the badge word, its tone, and the menu line. */
const POLICIES: Record<
  Policy,
  {
    badge: string;
    badgeClass: string;
    Icon: typeof Check;
    menu: string;
    hint: string;
  }
> = {
  allow: {
    badge: "Without asking",
    badgeClass:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    Icon: UserCheck,
    menu: "Without asking",
    hint: "The agent sends on its own.",
  },
  ask: {
    badge: "Asks you first",
    badgeClass: "",
    Icon: ShieldCheck,
    menu: "Ask me first",
    hint: "You approve each message.",
  },
  blocked: {
    badge: "Blocked",
    badgeClass:
      "border-destructive/30 bg-destructive/10 text-destructive dark:text-red-400",
    Icon: Slash,
    menu: "Block",
    hint: "No messages, no mentions.",
  },
};

const ORDER: readonly Policy[] = ["allow", "ask", "blocked"];

interface OutboundControlProps {
  agentId: string;
  agentName: string;
  /** Who the agent would be messaging, as shown on the row. */
  subject: string;
  /** The standing outbound decision, or null when there is none yet: the
   *  default then applies (every send asks you first). */
  contact: AgentContact | null;
}

/**
 * The OUTBOUND half of a contact: may the agent message this person,
 * channel or app on its own (send_message)? The badge is the reading and,
 * pressed, offers the three words. With no contact row yet there is
 * nothing to change: the default (ask first) is said quietly instead.
 */
export const OutboundControl = ({
  agentId,
  agentName,
  subject,
  contact,
}: OutboundControlProps) => {
  const setPolicy = useSetContactPolicy(agentId);

  if (!contact) {
    return (
      <DirectionPlaceholder
        label="Asks you first"
        description={`${agentName} asks you before messaging ${subject}.`}
      />
    );
  }

  const mine = POLICIES[contact.policy];

  const choose = (policy: Policy) => {
    if (policy === contact.policy) return;
    // Instant: the badge shows the new standing on click; a failure puts it
    // back and says why. Never frozen while saving.
    setPolicy.mutate({ contactId: contact.id, policy });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 px-2"
          aria-label={`Can ${agentName} message ${subject} on its own: ${mine.badge.toLowerCase()}. Change`}
        >
          <Badge variant="secondary" className={mine.badgeClass}>
            <mine.Icon className="size-3" aria-hidden />
            {mine.badge}
          </Badge>
          <ChevronDown className="text-muted-foreground size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="font-normal text-pretty">
          Can <span translate="no">{agentName}</span> message{" "}
          <span translate="no">{subject}</span> on its own?
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {ORDER.map((policy) => (
          <DropdownMenuItem
            key={policy}
            onSelect={() => choose(policy)}
            className="items-start gap-2"
          >
            <Check
              className={cn(
                "mt-0.5 size-3.5 shrink-0",
                contact.policy !== policy && "invisible",
              )}
              aria-hidden
            />
            <span className="min-w-0">
              <span className="block text-sm">{POLICIES[policy].menu}</span>
              <span className="text-muted-foreground block text-xs text-pretty">
                {POLICIES[policy].hint}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
