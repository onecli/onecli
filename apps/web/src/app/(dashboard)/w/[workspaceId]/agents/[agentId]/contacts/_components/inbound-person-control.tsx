"use client";

import { Check, ChevronDown, Loader2, Slash, UserCheck } from "lucide-react";
import { toast } from "sonner";
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
import type { ChannelPersonReach, ChannelProvider } from "@/lib/api";
import { useSetPersonReachState } from "@/hooks/use-channels";
import { DirectionPlaceholder } from "./direction-placeholder";
import { WaitingInBellBadge } from "./waiting-in-bell-badge";

interface InboundPersonControlProps {
  agentId: string;
  agentName: string;
  subject: string;
  /** The inbound record, or null when there is none. Null claims nothing:
   *  a workspace member is always answered and keeps no record, anyone
   *  else is asked about on their first message, and this row cannot
   *  tell which it is. */
  reach: { provider: ChannelProvider; value: ChannelPersonReach } | null;
}

/**
 * The INBOUND half of a person: when they message the agent, does it
 * answer? Two settlements only ("OneCLI users only" describes a
 * population, and this is one human). PENDING is not a setting yet:
 * deciding lives in the approvals bell, the one inbox.
 */
export const InboundPersonControl = ({
  agentId,
  agentName,
  subject,
  reach,
}: InboundPersonControlProps) => {
  // Hooks before any early return; the provider only matters once a
  // settled row exists to change.
  const setState = useSetPersonReachState(agentId, reach?.provider ?? "slack");
  if (!reach) {
    return (
      <DirectionPlaceholder
        label="No setting"
        description={`No setting for messages from ${subject} to ${agentName}.`}
      />
    );
  }
  if (reach.value.state === "pending") return <WaitingInBellBadge />;
  const person = reach.value;
  const approved = person.state === "approved";
  const StatusIcon = approved ? UserCheck : Slash;

  const choose = (state: "approved" | "blocked") => {
    if (state === person.state) return;
    setState.mutate(
      { externalRef: person.externalRef, state },
      {
        onSuccess: () =>
          toast.success(
            `${subject} → ${agentName}: ${state === "approved" ? "allowed" : "not allowed"}`,
          ),
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : "Update failed"),
      },
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={setState.isPending}>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 px-2"
          aria-label={`Can ${subject} message ${agentName}: ${
            approved ? "allowed" : "not allowed"
          }. Change`}
        >
          {setState.isPending ? (
            <Loader2
              className="size-3.5 animate-spin motion-reduce:hidden"
              aria-hidden
            />
          ) : null}
          <Badge
            variant="secondary"
            className={
              approved
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-destructive/30 bg-destructive/10 text-destructive dark:text-red-400"
            }
          >
            <StatusIcon className="size-3" aria-hidden />
            {approved ? "Allowed" : "Not allowed"}
          </Badge>
          <ChevronDown className="text-muted-foreground size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="font-normal text-pretty">
          Can <span translate="no">{subject}</span> message{" "}
          <span translate="no">{agentName}</span>?
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => choose("approved")}
          className="items-start gap-2"
        >
          <Check
            className={cn("mt-0.5 size-3.5 shrink-0", !approved && "invisible")}
            aria-hidden
          />
          <span className="min-w-0">
            <span className="block text-sm">Allowed</span>
            <span className="text-muted-foreground block text-xs text-pretty">
              The agent answers them.
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => choose("blocked")}
          className="items-start gap-2"
        >
          <Check
            className={cn("mt-0.5 size-3.5 shrink-0", approved && "invisible")}
            aria-hidden
          />
          <span className="min-w-0">
            <span className="block text-sm">Not allowed</span>
            <span className="text-muted-foreground block text-xs text-pretty">
              Silent to them in DMs and in channels.
            </span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
