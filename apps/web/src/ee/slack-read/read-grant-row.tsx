"use client";

import { useState } from "react";
import {
  Check,
  ChevronDown,
  Hash,
  Loader2,
  Lock,
  MessageCircle,
  MoreHorizontal,
  Trash2,
  Users,
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
import type { ConversationKind, ReadAudience, ReadGrant } from "./api";
import { useDeleteReadGrant, useSetReadGrant } from "./hooks";

export const AUDIENCES = {
  granter_only: {
    label: "Only me",
    icon: Lock,
    hint: "Only you can ask the agent to read it, in your direct messages or your schedules. Your teammates can see schedule runs, and the agent may remember what it read.",
    badge: "",
  },
  anyone: {
    label: "Anyone",
    icon: Users,
    hint: "Anyone the agent talks to can ask about it.",
    badge:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
} as const satisfies Record<
  ReadAudience,
  { label: string; icon: typeof Lock; hint: string; badge: string }
>;
export const AUDIENCE_ORDER = ["granter_only", "anyone"] as const;

export const KIND_ICON: Record<ConversationKind, typeof Hash> = {
  channel: Hash,
  private_channel: Lock,
  dm: MessageCircle,
  group_dm: Users,
};

export interface ReadGrantRowProps {
  agentId: string;
  grant: ReadGrant;
}

/**
 * One shared conversation, in the same three-column shape as a Contacts row:
 * WHAT it is (with who shared it beneath), WHO may ask about it (the badge;
 * pressed, it offers the other answer - only for the person who shared it,
 * since it is their Slack), and one quiet `…` holding Remove behind a
 * confirm. Anyone who manages the agent may remove a share: removing only
 * ever narrows what the agent can read.
 */
export const ReadGrantRow = ({ agentId, grant }: ReadGrantRowProps) => {
  const setGrant = useSetReadGrant(agentId);
  const remove = useDeleteReadGrant(agentId);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const label = grant.subjectLabel ?? grant.externalRef;
  const audience = AUDIENCES[grant.audience];
  const AudienceIcon = audience.icon;
  const KindIcon = KIND_ICON[grant.subjectKind];
  const mine = grant.mine;
  const granter = mine
    ? "you"
    : grant.grantedBy.name?.trim() || grant.grantedBy.email;
  const busy = setGrant.isPending || remove.isPending;

  const choose = (next: ReadAudience) => {
    if (next === grant.audience) return;
    setGrant.mutate(
      { externalRef: grant.externalRef, audience: next },
      {
        onSuccess: () => toast.success(`${label}: ${AUDIENCES[next].label}`),
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : "Update failed"),
      },
    );
  };

  const badge = (
    <Badge variant="secondary" className={audience.badge}>
      <AudienceIcon className="size-3" aria-hidden />
      {audience.label}
    </Badge>
  );

  return (
    <>
      <div className="flex min-h-12 items-center gap-3 py-2">
        <KindIcon
          className="text-muted-foreground size-4 shrink-0"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm" translate="no">
            {label}
          </p>
          <p className="text-muted-foreground truncate text-xs">
            Shared by {granter}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {mine ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild disabled={busy}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 px-2"
                  aria-label={`Who can ask about ${label}: ${audience.label}. Change`}
                >
                  {setGrant.isPending && (
                    <Loader2
                      className="size-3.5 animate-spin motion-reduce:hidden"
                      aria-hidden
                    />
                  )}
                  {badge}
                  <ChevronDown
                    className="text-muted-foreground size-3.5"
                    aria-hidden
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuLabel className="text-pretty font-normal">
                  Who can ask about <span translate="no">{label}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {AUDIENCE_ORDER.map((value) => {
                  const option = AUDIENCES[value];
                  return (
                    <DropdownMenuItem
                      key={value}
                      onSelect={() => choose(value)}
                      className="items-start gap-2"
                    >
                      <Check
                        className={`mt-0.5 size-3.5 shrink-0 ${value === grant.audience ? "" : "invisible"}`}
                        aria-hidden
                      />
                      <span className="min-w-0">
                        <span className="block text-sm">{option.label}</span>
                        <span className="text-muted-foreground block text-xs text-pretty">
                          {option.hint}
                        </span>
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            // Not yours to re-scope: the badge reads, the title explains.
            <span className="px-2" title={audience.hint}>
              {badge}
            </span>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={busy}>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`More for ${label}`}
              >
                <MoreHorizontal className="size-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setConfirmOpen(true)}
              >
                <Trash2 className="size-4" aria-hidden />
                Stop sharing
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-pretty">
              Stop sharing <span translate="no">{label}</span>?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              The agent won&apos;t be able to read it anymore.
              {mine ? " You can share it again any time." : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                remove.mutate(grant.id, {
                  onSuccess: () => {
                    setConfirmOpen(false);
                    toast.success(`${label} removed`);
                  },
                  onError: (err) => {
                    setConfirmOpen(false);
                    toast.error(
                      err instanceof Error ? err.message : "Remove failed",
                    );
                  },
                });
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
                "Stop sharing"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
