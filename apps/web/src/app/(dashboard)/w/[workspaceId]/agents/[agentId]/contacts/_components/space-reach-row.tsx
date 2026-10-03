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
import { ContactRowFrame } from "./contact-row-frame";

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
    menuTitle: "Anyone here",
    menuHint: "Everyone in the channel.",
    badge:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    toast: "anyone here",
  },
  members_only: {
    label: "OneCLI users",
    icon: Lock,
    menuTitle: "OneCLI users",
    menuHint: "Only people with a OneCLI account.",
    badge: "",
    toast: "OneCLI users only",
  },
  blocked: {
    label: "Not allowed",
    icon: Slash,
    menuTitle: "Not allowed",
    menuHint: "The agent stays silent here.",
    badge:
      "border-destructive/30 bg-destructive/10 text-destructive dark:text-red-400",
    toast: "not allowed",
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
 * yet, and until they do the agent answers no one here. Remove is the
 * separate, destructive-shaped action: it forgets the channel entirely.
 * It lives last in the row's `…` menu (the shared frame) behind a confirm
 * dialog with recovery copy.
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

  // A PENDING row is not a setting yet - deciding lives in the approvals
  // bell (4d), the one inbox. This row only says where the wait is.
  if (!settled) {
    return (
      <ContactRowFrame
        label={label}
        mono
        status={
          <Badge
            variant="secondary"
            className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
          >
            <Clock className="size-3" aria-hidden />
            Waiting in the approvals bell
          </Badge>
        }
      />
    );
  }

  return (
    <>
      <ContactRowFrame
        label={label}
        mono
        disabled={busy}
        onRemove={() => setConfirmOpen(true)}
        status={
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
                Who can talk to the agent in{" "}
                <span className="font-mono" translate="no">
                  {label}
                </span>
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
        }
      />

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
              The next message there will ask you again.
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
