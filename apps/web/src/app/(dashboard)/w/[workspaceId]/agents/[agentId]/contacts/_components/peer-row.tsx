"use client";

import { useState } from "react";
import {
  Check,
  ChevronDown,
  Loader2,
  MessagesSquare,
  PauseCircle,
  Play,
  Slash,
  ShieldCheck,
  UserCheck,
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
import type { AgentPeer } from "@/lib/api";
import {
  useForgetPeer,
  useResumePeer,
  useSetPeerPolicy,
} from "@/hooks/use-channels";
import { ContactRowFrame } from "./contact-row-frame";
import { PeerConversationDialog } from "./peer-conversation-dialog";

interface PeerRowProps {
  agentId: string;
  agentName: string;
  peer: AgentPeer;
}

type Policy = AgentPeer["myPolicy"];

/** One policy's face: the badge word and the menu line. */
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
    badge: "Allowed",
    badgeClass:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    Icon: UserCheck,
    menu: "Allow",
    hint: "No approval needed.",
  },
  ask: {
    badge: "Asks first",
    badgeClass: "",
    Icon: ShieldCheck,
    menu: "Ask me first",
    hint: "You approve each conversation.",
  },
  blocked: {
    badge: "Blocked",
    badgeClass:
      "border-destructive/30 bg-destructive/10 text-destructive dark:text-red-400",
    Icon: Slash,
    menu: "Block",
    hint: "No messages either way.",
  },
};

/**
 * One peer agent's row (PR 5b): THIS agent's side of the pair as the
 * badge-as-trigger menu (the reach rows' pattern), the other side's word
 * beside it when it differs, and the `…` menu: View conversation (once the
 * pair has talked) and Remove, which forgets THIS side's policy, transcript
 * and pending asks - the peer stays listed at ask/ask, since it still
 * exists. One relationship, one policy word per side: the badge is what
 * THIS agent's owner decided; "allow" here never makes the other side allow.
 *
 * A PAUSED pair (past the turn cap, the loop brake) is said out loud: a
 * Paused badge beside the policy, and Resume first in the `…` menu. Consent
 * and the pause are independent (an Allowed pair can be paused), so the
 * policy badge stays as it is. A pair with an open peer task (one agent
 * asking for a person) wears a quiet Working badge: someone is waiting on a
 * report, and the pair conversation is where it is being worked out.
 */
export const PeerRow = ({ agentId, agentName, peer }: PeerRowProps) => {
  const setPolicy = useSetPeerPolicy(agentId);
  const forget = useForgetPeer(agentId);
  const resume = useResumePeer(agentId);
  const [conversationOpen, setConversationOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Nothing to forget while the pair is pristine and has never talked.
  const removable =
    peer.myPolicy !== "ask" ||
    peer.theirPolicy !== "ask" ||
    peer.conversationId !== null;
  const mine = POLICIES[peer.myPolicy];
  const label = peer.workspaceName
    ? `${peer.name} · ${peer.workspaceName}`
    : peer.name;

  const choose = (policy: Policy) => {
    if (policy === peer.myPolicy) return;
    setPolicy.mutate(
      { peerAgentId: peer.agentId, policy },
      {
        onSuccess: () =>
          toast.success(
            `${peer.name}: ${POLICIES[policy].badge.toLowerCase()}`,
          ),
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : "Update failed"),
      },
    );
  };

  const doResume = () =>
    resume.mutate(peer.agentId, {
      onSuccess: () => toast.success(`${peer.name}: resumed`),
      onError: (err) =>
        toast.error(err instanceof Error ? err.message : "Resume failed"),
    });

  const confirmRemove = () =>
    forget.mutate(peer.agentId, {
      onSuccess: () => {
        setConfirmOpen(false);
        toast.success(`${peer.name} removed`);
      },
      onError: (err) => {
        setConfirmOpen(false);
        toast.error(err instanceof Error ? err.message : "Remove failed");
      },
    });

  return (
    <>
      <ContactRowFrame
        label={label}
        disabled={setPolicy.isPending || forget.isPending || resume.isPending}
        {...(removable && { onRemove: () => setConfirmOpen(true) })}
        actions={[
          // Offered only while paused: the one thing to do about a pause.
          ...(peer.paused
            ? [
                {
                  label: "Resume",
                  icon: <Play className="size-4" aria-hidden />,
                  onSelect: doResume,
                },
              ]
            : []),
          {
            label: "View conversation",
            icon: <MessagesSquare className="size-4" aria-hidden />,
            onSelect: () => setConversationOpen(true),
            // Nothing to show until they have talked; the item stays so the
            // menu's shape is the same on every row.
            disabled: peer.conversationId === null,
          },
        ]}
        status={
          <>
            {peer.taskOpen && (
              <Badge
                variant="outline"
                className="text-muted-foreground shrink-0 font-normal"
              >
                <Loader2
                  className="size-3 animate-spin motion-reduce:hidden"
                  aria-hidden
                />
                Working
              </Badge>
            )}
            {peer.paused && (
              <Badge
                variant="secondary"
                className="shrink-0 border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
              >
                <PauseCircle className="size-3" aria-hidden />
                Paused
              </Badge>
            )}
            {/* The OTHER owner's word, only when it is not the default: two
                "Asks first" badges side by side would read as one setting. */}
            {peer.theirPolicy !== "ask" && (
              <Badge
                variant="outline"
                className="text-muted-foreground shrink-0 font-normal"
              >
                Their side: {POLICIES[peer.theirPolicy].badge.toLowerCase()}
              </Badge>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild disabled={setPolicy.isPending}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 px-2"
                  aria-label={`Whether ${agentName} and ${peer.name} may message each other: ${mine.badge.toLowerCase()}. Change`}
                >
                  {setPolicy.isPending ? (
                    <Loader2
                      className="size-3.5 animate-spin motion-reduce:hidden"
                      aria-hidden
                    />
                  ) : null}
                  <Badge variant="secondary" className={mine.badgeClass}>
                    <mine.Icon className="size-3" aria-hidden />
                    {mine.badge}
                  </Badge>
                  <ChevronDown
                    className="text-muted-foreground size-3.5"
                    aria-hidden
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuLabel className="font-normal text-pretty">
                  <span translate="no">{agentName}</span> and{" "}
                  <span translate="no">{peer.name}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {(["allow", "ask", "blocked"] as const).map((policy) => (
                  <DropdownMenuItem
                    key={policy}
                    onSelect={() => choose(policy)}
                    className="items-start gap-2"
                  >
                    <Check
                      className={`mt-0.5 size-3.5 shrink-0 ${peer.myPolicy === policy ? "" : "invisible"}`}
                      aria-hidden
                    />
                    <span className="min-w-0">
                      <span className="block text-sm">
                        {POLICIES[policy].menu}
                      </span>
                      <span className="text-muted-foreground block text-xs text-pretty">
                        {POLICIES[policy].hint}
                      </span>
                    </span>
                  </DropdownMenuItem>
                ))}
                {peer.theirPolicy !== "allow" && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-muted-foreground text-xs font-normal text-pretty">
                      {peer.theirPolicy === "blocked"
                        ? `Blocked on ${peer.name}’s side.`
                        : `${peer.name}’s side must allow too.`}
                    </DropdownMenuLabel>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-pretty">
              Remove <span translate="no">{peer.name}</span>?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              Clears your side: the setting, the conversation, and any pending
              asks. The next message will ask you again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={forget.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                confirmRemove();
              }}
              disabled={forget.isPending}
              className={buttonVariants({ variant: "destructive" })}
            >
              {forget.isPending ? (
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

      {peer.conversationId !== null && (
        <PeerConversationDialog
          open={conversationOpen}
          onOpenChange={setConversationOpen}
          conversationId={peer.conversationId}
          agentName={agentName}
          peerName={peer.name}
          paused={peer.paused}
        />
      )}
    </>
  );
};
