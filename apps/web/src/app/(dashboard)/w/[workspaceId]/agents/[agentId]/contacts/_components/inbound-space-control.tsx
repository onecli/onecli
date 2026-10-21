"use client";

import { Check, ChevronDown, Globe, Lock, Slash } from "lucide-react";
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
import type {
  ChannelProvider,
  ChannelReachState,
  ChannelSpaceReach,
} from "@/lib/api";
import { useSetReachState } from "@/hooks/use-channels";
import { DirectionPlaceholder } from "./direction-placeholder";
import { WaitingInBellBadge } from "./waiting-in-bell-badge";

/** A settlement's face: the badge word, who it answers (for sentences, so
 *  a brand name is never lowercased), and the menu's explanation. The
 *  states name WHICH membership they mean ("members" alone is ambiguous:
 *  Slack channel members vs OneCLI users). */
const SETTLEMENTS = {
  approved: {
    label: "Anyone here",
    answers: "anyone here",
    icon: Globe,
    menuHint: "Everyone in the channel.",
    badge:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  members_only: {
    label: "OneCLI users",
    answers: "OneCLI users only",
    icon: Lock,
    menuHint: "Only people with a OneCLI account.",
    badge: "",
  },
  blocked: {
    label: "No one",
    answers: "no one",
    icon: Slash,
    menuHint: "The agent stays silent here.",
    badge:
      "border-destructive/30 bg-destructive/10 text-destructive dark:text-red-400",
  },
} as const satisfies Record<
  Exclude<ChannelReachState, "pending">,
  {
    label: string;
    answers: string;
    icon: typeof Globe;
    menuHint: string;
    badge: string;
  }
>;

const ORDER = ["approved", "members_only", "blocked"] as const;

interface InboundSpaceControlProps {
  agentId: string;
  agentName: string;
  subject: string;
  /** The inbound record, or null when the channel has none on show. */
  reach: { provider: ChannelProvider; value: ChannelSpaceReach } | null;
}

/**
 * The INBOUND half of a channel: when someone there talks to the agent,
 * who does it answer? Exclusive and three-way, so a radio menu, not a
 * toggle. PENDING is not a setting yet: it lives in the approvals bell.
 */
export const InboundSpaceControl = ({
  agentId,
  agentName,
  subject,
  reach,
}: InboundSpaceControlProps) => {
  // Hooks before any early return; the provider only matters once a
  // settled row exists to change.
  const setReach = useSetReachState(agentId, reach?.provider ?? "slack");
  if (!reach) {
    // The next message there asks the owner before the agent answers
    // anyone (the channel gate's no-row arm), so the default is said.
    return (
      <DirectionPlaceholder
        label="Asks you first"
        description={`${agentName} asks you before answering anyone in ${subject}.`}
      />
    );
  }
  if (reach.value.state === "pending") return <WaitingInBellBadge />;
  const space = reach.value;
  const current = reach.value.state;
  const settled = SETTLEMENTS[current];

  const choose = (state: (typeof ORDER)[number]) => {
    if (state === current) return;
    // Instant: the badge shows the new answer on click; a failure puts it
    // back and says why. Never frozen while saving.
    setReach.mutate({ externalRef: space.externalRef, state });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 px-2"
          aria-label={`Who ${agentName} answers in ${subject}: ${settled.answers}. Change`}
        >
          <Badge variant="secondary" className={settled.badge}>
            <settled.icon className="size-3" aria-hidden />
            {settled.label}
          </Badge>
          <ChevronDown className="text-muted-foreground size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="font-normal text-pretty">
          Who does <span translate="no">{agentName}</span> answer in{" "}
          <span className="font-mono" translate="no">
            {subject}
          </span>
          ?
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {ORDER.map((state) => {
          const option = SETTLEMENTS[state];
          return (
            <DropdownMenuItem
              key={state}
              onSelect={() => choose(state)}
              // The current setting stays selectable-looking, not disabled:
              // a disabled item drops out of the keyboard walk.
              className="items-start gap-2"
            >
              <Check
                className={cn(
                  "mt-0.5 size-3.5 shrink-0",
                  state !== current && "invisible",
                )}
                aria-hidden
              />
              <span className="min-w-0">
                <span className="block text-sm">{option.label}</span>
                <span className="text-muted-foreground block text-xs text-pretty">
                  {option.menuHint}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
