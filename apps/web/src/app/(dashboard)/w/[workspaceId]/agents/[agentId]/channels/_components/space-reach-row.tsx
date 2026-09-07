"use client";

import { useState } from "react";
import {
  Check,
  ChevronDown,
  Clock,
  Globe,
  Loader2,
  Lock,
  Slash,
  X,
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
import type {
  ChannelProvider,
  ChannelSpaceReach,
  ChannelReachState,
} from "@/lib/api";
import { useDismissReachRow, useSetReachState } from "@/hooks/use-channels";

interface SpaceReachRowProps {
  agentId: string;
  provider: ChannelProvider;
  space: ChannelSpaceReach;
}

/** A settlement's face: what the badge says, and what the menu explains. */
const SETTLEMENTS = {
  approved: {
    label: "Anyone here",
    icon: Globe,
    menuTitle: "Allow anyone here",
    menuHint: "Everyone in the channel can talk to the agent.",
    badge:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    toast: "answering anyone in the channel",
  },
  members_only: {
    label: "OneCLI users",
    icon: Lock,
    menuTitle: "OneCLI users only",
    menuHint: "Only your linked teammates are answered here.",
    badge: "",
    toast: "OneCLI users only",
  },
  blocked: {
    label: "Not allowed",
    icon: Slash,
    menuTitle: "Don’t allow",
    menuHint: "The agent stays silent in this channel.",
    badge:
      "border-destructive/30 bg-destructive/10 text-destructive dark:text-red-400",
    toast: "not answering there",
  },
} as const satisfies Record<
  Exclude<ChannelReachState, "pending">,
  {
    label: string;
    icon: typeof Globe;
    menuTitle: string;
    menuHint: string;
    badge: string;
    toast: string;
  }
>;

const ORDER = ["approved", "members_only", "blocked"] as const;

/**
 * One channel's reach row - the dashboard face the owner clicks.
 *
 * The choice is EXCLUSIVE and three-way, so the control is a menu of radio
 * options rather than a toggle: a toggle can only tell a two-sided story,
 * and "not everyone" is not the same answer as "not at all". The trigger is
 * the status itself - the row states what is true and, pressed, offers what
 * else it could be, so reading and changing are the same object instead of
 * a label plus a mystery button.
 *
 * The vocabulary problem it also solves: "members" is ambiguous (Slack
 * channel members vs OneCLI workspace users), so the states name the side
 * they mean - `OneCLI users` vs `Anyone here`.
 *
 * `pending` is a real state, not a styling of "off": nobody has answered
 * yet, and until they do the agent answers no one here. Dismiss is the
 * separate, destructive-shaped action: it forgets the channel entirely
 * (subordinate icon, confirm dialog, recovery copy).
 */
export const SpaceReachRow = ({
  agentId,
  provider,
  space,
}: SpaceReachRowProps) => {
  const setReach = useSetReachState(agentId, provider);
  const dismiss = useDismissReachRow(agentId, provider);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const label = space.label ?? space.externalRef;
  // Narrowed inline (not via a separate boolean) so the union tells the
  // compiler which branch has a settlement to describe.
  const settled = space.state === "pending" ? null : SETTLEMENTS[space.state];
  const busy = setReach.isPending || dismiss.isPending;

  const choose = (state: (typeof ORDER)[number]) => {
    if (state === space.state) return;
    setReach.mutate(
      { externalRef: space.externalRef, state },
      {
        onSuccess: () => toast.success(`${label}: ${SETTLEMENTS[state].toast}`),
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : "Update failed"),
      },
    );
  };

  const confirmDismiss = () => {
    dismiss.mutate(
      { externalRef: space.externalRef },
      {
        onSuccess: () => {
          setConfirmOpen(false);
          toast.success(`${label} removed`);
        },
        onError: (err) => {
          setConfirmOpen(false);
          toast.error(err instanceof Error ? err.message : "Remove failed");
        },
      },
    );
  };

  const StatusIcon = settled?.icon ?? Clock;

  return (
    <>
      <div className="group flex min-h-11 items-center justify-between gap-3 py-1.5">
        {/* translate="no": a channel name is an identifier, not prose. */}
        <span className="truncate font-mono text-sm" translate="no">
          {label}
        </span>

        <div className="flex shrink-0 items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={busy}>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 px-2"
                aria-label={`Who ${label} is answered for: ${
                  settled?.label ?? "waiting for approval"
                }. Change`}
              >
                {setReach.isPending ? (
                  <Loader2
                    className="size-3.5 animate-spin motion-reduce:hidden"
                    aria-hidden
                  />
                ) : null}
                <Badge
                  variant="secondary"
                  className={
                    settled?.badge ??
                    "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                  }
                >
                  <StatusIcon className="size-3" aria-hidden />
                  {settled?.label ?? "Asked, pending"}
                </Badge>
                <ChevronDown
                  className="text-muted-foreground size-3.5"
                  aria-hidden
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuLabel className="text-pretty font-normal">
                Who can talk to this agent in{" "}
                <span className="font-mono" translate="no">
                  {label}
                </span>
                ?
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {ORDER.map((state) => {
                const option = SETTLEMENTS[state];
                const active = state === space.state;
                return (
                  <DropdownMenuItem
                    key={state}
                    onSelect={() => choose(state)}
                    // The current setting is shown checked but stays
                    // selectable-looking rather than disabled: a disabled
                    // item drops out of the keyboard walk, which makes the
                    // menu unreadable to anyone not using a pointer.
                    className="items-start gap-2"
                  >
                    <Check
                      className={`mt-0.5 size-3.5 shrink-0 ${active ? "" : "invisible"}`}
                      aria-hidden
                    />
                    <span className="min-w-0">
                      <span className="block text-sm">{option.menuTitle}</span>
                      <span className="text-muted-foreground block text-xs text-pretty">
                        {option.menuHint}
                      </span>
                    </span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${label} from this list`}
            // `title` is the native affordance here: it labels the icon for
            // pointer users without mounting a popper (and its layout
            // observers) on every row.
            title="Remove from list"
            // Quiet until the row is engaged, never hidden from those who
            // cannot hover: opacity-only (stays in layout and tab order),
            // revealed on group hover/focus, and always solid on coarse
            // pointers. Opacity alone transitions — never `transition: all`.
            className="text-muted-foreground hover:text-destructive opacity-60 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none pointer-coarse:opacity-100 sm:opacity-0"
            onClick={() => setConfirmOpen(true)}
            disabled={busy}
          >
            <X className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-pretty">
              Remove{" "}
              <span className="font-mono" translate="no">
                {label}
              </span>
              ?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              This forgets the channel: its setting is cleared and its threads
              are unlinked. The next message there will ask you to decide again,
              and the agent stays quiet until you do.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dismiss.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                // Keep the dialog open while the request runs; close on
                // settle so the outcome toast is the next thing seen.
                event.preventDefault();
                confirmDismiss();
              }}
              disabled={dismiss.isPending}
              // The system's destructive treatment, not a hand-rolled one -
              // hover/focus contrast and dark-mode pairing come with it.
              className={buttonVariants({ variant: "destructive" })}
            >
              {dismiss.isPending ? (
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
