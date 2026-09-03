"use client";

import { useState } from "react";
import {
  Check,
  ChevronDown,
  Clock,
  Loader2,
  Slash,
  UserCheck,
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
import type { ChannelPersonReach, ChannelProvider } from "@/lib/api";
import {
  useDismissPersonReach,
  useSetPersonReachState,
} from "@/hooks/use-channels";

interface PersonReachRowProps {
  agentId: string;
  provider: ChannelProvider;
  person: ChannelPersonReach;
}

/**
 * One person's reach row - someone who messaged the agent directly but has
 * no OneCLI account to match.
 *
 * TWO settlements, not the channel's three: "OneCLI users only" describes a
 * population, and this row is about one human. Sibling of SpaceReachRow by
 * design (same badge-as-trigger pattern, same dismiss affordance) but
 * deliberately its own component - the vocabularies differ, and collapsing
 * them into one polymorphic row would mean a menu whose options change
 * shape based on a kind flag.
 */
export const PersonReachRow = ({
  agentId,
  provider,
  person,
}: PersonReachRowProps) => {
  const setState = useSetPersonReachState(agentId, provider);
  const dismiss = useDismissPersonReach(agentId, provider);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const label = person.label ?? person.externalRef;
  const busy = setState.isPending || dismiss.isPending;

  const choose = (state: "approved" | "blocked") => {
    if (state === person.state) return;
    setState.mutate(
      { externalRef: person.externalRef, state },
      {
        onSuccess: () =>
          toast.success(
            state === "approved"
              ? `${label}: the agent will answer them`
              : `${label}: not answering them`,
          ),
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : "Update failed"),
      },
    );
  };

  const confirmDismiss = () => {
    dismiss.mutate(
      { externalRef: person.externalRef },
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

  const approved = person.state === "approved";
  const pending = person.state === "pending";
  const StatusIcon = approved ? UserCheck : pending ? Clock : Slash;

  return (
    <>
      <div className="group flex min-h-11 items-center justify-between gap-3 py-1.5">
        <span className="truncate text-sm" translate="no">
          {label}
        </span>

        <div className="flex shrink-0 items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={busy}>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 px-2"
                aria-label={`Whether ${label} can message this agent: ${
                  approved
                    ? "allowed"
                    : pending
                      ? "waiting for approval"
                      : "not allowed"
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
                      : pending
                        ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                        : "border-destructive/30 bg-destructive/10 text-destructive dark:text-red-400"
                  }
                >
                  <StatusIcon className="size-3" aria-hidden />
                  {approved
                    ? "Allowed"
                    : pending
                      ? "Asked, pending"
                      : "Not allowed"}
                </Badge>
                <ChevronDown
                  className="text-muted-foreground size-3.5"
                  aria-hidden
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuLabel className="font-normal text-pretty">
                Can <span translate="no">{label}</span> message this agent?
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => choose("approved")}
                className="items-start gap-2"
              >
                <Check
                  className={`mt-0.5 size-3.5 shrink-0 ${approved ? "" : "invisible"}`}
                  aria-hidden
                />
                <span className="min-w-0">
                  <span className="block text-sm">Allow this person</span>
                  <span className="text-muted-foreground block text-xs text-pretty">
                    They can talk to the agent in their direct message.
                  </span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => choose("blocked")}
                className="items-start gap-2"
              >
                <Check
                  className={`mt-0.5 size-3.5 shrink-0 ${person.state === "blocked" ? "" : "invisible"}`}
                  aria-hidden
                />
                <span className="min-w-0">
                  <span className="block text-sm">Don’t allow</span>
                  <span className="text-muted-foreground block text-xs text-pretty">
                    The agent stays silent, here and in any open channel.
                  </span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${label} from this list`}
            title="Remove from list"
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
              Remove <span translate="no">{label}</span>?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              This forgets the decision about them. If they message the agent
              again, you’ll be asked once more, and the agent stays quiet until
              you answer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dismiss.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                confirmDismiss();
              }}
              disabled={dismiss.isPending}
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
