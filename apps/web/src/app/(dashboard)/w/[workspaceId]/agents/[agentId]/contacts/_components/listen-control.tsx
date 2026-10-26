"use client";

import { AtSign, Check, ChevronDown, Ear } from "lucide-react";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { cn } from "@onecli/ui/lib/utils";
import type {
  ChannelListenMode,
  ChannelProvider,
  ChannelSpaceReach,
} from "@/lib/api";
import { useSetSpaceListen } from "@/hooks/use-channels";

/** The two answers, worded for the badge and the menu. */
const MODES = {
  mentions: {
    // The @ icon already says "mention": the word stays plain.
    label: "Mentions",
    icon: AtSign,
    menuTitle: "Only @mentions",
    menuHint: (agent: string) =>
      `${agent} hears a message here only when someone @mentions it, or in a thread it joined.`,
    badge: "",
  },
  all: {
    label: "Point of contact",
    icon: Ear,
    menuTitle: "Every message (point of contact)",
    menuHint: (agent: string) =>
      `${agent} reads everything posted here and decides on its own when to reply. An @mention always gets an answer.`,
    badge:
      "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  },
} as const satisfies Record<
  ChannelListenMode,
  {
    label: string;
    icon: typeof Ear;
    menuTitle: string;
    menuHint: (agent: string) => string;
    badge: string;
  }
>;

const ORDER = ["mentions", "all"] as const;

export interface ListenControlProps {
  agentId: string;
  agentName: string;
  subject: string;
  reach: { provider: ChannelProvider; value: ChannelSpaceReach } | null;
}

/**
 * What the agent HEARS in a channel - the "promote to point of contact"
 * control, beside who it answers there. Promoting needs a settlement that
 * answers someone: while the channel is pending, unknown, or set to
 * "No one", the control reads "Mentions" and explains why it can't move.
 */
export const ListenControl = ({
  agentId,
  agentName,
  subject,
  reach,
}: ListenControlProps) => {
  const setListen = useSetSpaceListen(agentId, reach?.provider ?? "slack");
  const current: ChannelListenMode = reach?.value.listen ?? "mentions";
  const mode = MODES[current];
  const answersSomeone =
    reach?.value.state === "approved" || reach?.value.state === "members_only";

  const badge = (
    <Badge variant="secondary" className={mode.badge}>
      <mode.icon className="size-3" aria-hidden />
      {mode.label}
    </Badge>
  );

  if (!reach || !answersSomeone) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Focusable so the reason is reachable by keyboard too. */}
          <span
            tabIndex={0}
            className="focus-visible:ring-ring inline-flex rounded-md px-2 py-1 focus-visible:ring-2 focus-visible:outline-none"
          >
            {badge}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64 text-pretty">
          Choose who {agentName} answers in {subject} first. Then you can make
          it the point of contact here.
        </TooltipContent>
      </Tooltip>
    );
  }

  const choose = (next: ChannelListenMode) => {
    if (next === current) return;
    // Instant: the badge shows the new mode on click; a failure puts it back
    // and says why. Never frozen while saving.
    setListen.mutate({ externalRef: reach.value.externalRef, listen: next });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 px-2"
          aria-label={`What ${agentName} hears in ${subject}: ${mode.menuTitle}. Change`}
        >
          {badge}
          <ChevronDown className="text-muted-foreground size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="text-pretty font-normal">
          What {agentName} hears in{" "}
          <span className="font-mono" translate="no">
            {subject}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {ORDER.map((value) => {
          const option = MODES[value];
          return (
            <DropdownMenuItem
              key={value}
              onSelect={() => choose(value)}
              className="items-start gap-2"
            >
              <Check
                className={cn(
                  "mt-0.5 size-3.5 shrink-0",
                  value !== current && "invisible",
                )}
                aria-hidden
              />
              <span className="min-w-0">
                <span className="block text-sm">{option.menuTitle}</span>
                <span className="text-muted-foreground block text-xs text-pretty">
                  {option.menuHint(agentName)}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
