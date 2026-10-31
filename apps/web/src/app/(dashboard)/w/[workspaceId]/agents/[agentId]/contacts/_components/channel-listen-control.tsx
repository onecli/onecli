"use client";

import { AtSign, Check, ChevronDown, Ear } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import { cn } from "@onecli/ui/lib/utils";
import type {
  ChannelListenMode,
  ChannelProvider,
  ChannelSpaceReach,
} from "@/lib/api";
import { useSetSpaceListen } from "@/hooks/use-channels";

/** What the agent replies to in a channel that is allowed. */
const MODES = {
  mentions: {
    label: "Mentions",
    icon: AtSign,
    menuHint: (agent: string) =>
      `${agent} replies when someone @mentions it or in a thread it joined.`,
  },
  all: {
    label: "Every message",
    icon: Ear,
    menuHint: (agent: string) =>
      `${agent} reads everything here and decides when to reply.`,
  },
} as const satisfies Record<
  ChannelListenMode,
  { label: string; icon: typeof Ear; menuHint: (agent: string) => string }
>;

const ORDER = ["mentions", "all"] as const;

export interface ChannelListenControlProps {
  agentId: string;
  agentName: string;
  subject: string;
  reach: { provider: ChannelProvider; value: ChannelSpaceReach };
}

/**
 * What the agent replies to in a channel: Mentions or Every message. Only
 * meaningful while the channel is allowed, so it renders nothing otherwise
 * (Never, or not answered yet).
 */
export const ChannelListenControl = ({
  agentId,
  agentName,
  subject,
  reach,
}: ChannelListenControlProps) => {
  const setListen = useSetSpaceListen(agentId, reach.provider);
  const space = reach.value;
  if (space.state !== "approved") return null;
  const listen: ChannelListenMode = space.listen ?? "mentions";
  const mode = MODES[listen];

  const choose = (next: ChannelListenMode) => {
    if (next === listen) return;
    // Instant: the badge shows the new mode on click; a failure puts it
    // back and says why.
    setListen.mutate({ externalRef: space.externalRef, listen: next });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 px-2"
          aria-label={`What ${agentName} replies to in ${subject}: ${mode.label}. Change`}
        >
          <Badge variant="secondary">
            <mode.icon className="size-3" aria-hidden />
            {mode.label}
          </Badge>
          <ChevronDown className="text-muted-foreground size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        {ORDER.map((option) => {
          const face = MODES[option];
          return (
            <DropdownMenuItem
              key={option}
              onSelect={() => choose(option)}
              className="items-start gap-2"
            >
              <Check
                className={cn(
                  "mt-0.5 size-3.5 shrink-0",
                  option !== listen && "invisible",
                )}
                aria-hidden
              />
              <span className="min-w-0">
                <span className="block text-sm">{face.label}</span>
                <span className="text-muted-foreground block text-xs text-pretty">
                  {face.menuHint(agentName)}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
