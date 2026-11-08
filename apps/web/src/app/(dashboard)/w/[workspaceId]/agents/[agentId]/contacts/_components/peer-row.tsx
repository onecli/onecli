"use client";

import { useState } from "react";
import { Loader2, MessagesSquare, PauseCircle, Play } from "lucide-react";
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
import { buttonVariants } from "@onecli/ui/components/button";
import type { AgentPeer } from "@/lib/api";
import {
  useForgetPeer,
  useResumePeer,
  useSetPeerPolicy,
} from "@/hooks/use-channels";
import { TriStateControl } from "../../_components/tri-state-control";
import { ContactRowFrame } from "./contact-row-frame";
import { AgentAvatar } from "@/lib/agents/_components/agent-avatar";
import { PeerConversationDialog } from "./peer-conversation-dialog";

interface PeerRowProps {
  agentId: string;
  agentName: string;
  peer: AgentPeer;
}

/** A pair has ONE setting, two answers: the app-permission icons. With no
 *  answer yet (`ask`) neither is pressed: the first message asks you once. */
const OPTIONS = ["allow", "never"] as const;

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
  const label = peer.workspaceName
    ? `${peer.name} · ${peer.workspaceName}`
    : peer.name;

  const choose = (policy: "allow" | "blocked") => {
    if (policy === peer.myPolicy) return;
    // Instant: the icon moves on click; a failure puts it back and says
    // why. Never frozen while saving.
    setPolicy.mutate({ peerAgentId: peer.agentId, policy });
  };

  const doResume = () =>
    resume.mutate(peer.agentId, {
      onSuccess: () => toast.success(`${peer.name}: resumed`),
      onError: (err) =>
        toast.error(err instanceof Error ? err.message : "Resume failed"),
    });

  // Instant: the pair reads cleared and the confirm closes on click. The
  // hook puts it back and says why if the server refuses.
  const confirmRemove = () => {
    setConfirmOpen(false);
    forget
      .mutateAsync(peer.agentId)
      .then(() => toast.success(`${peer.name} removed`))
      .catch(() => undefined);
  };

  return (
    <>
      <ContactRowFrame
        label={label}
        leading={
          <AgentAvatar agent={{ name: peer.name, imageUrl: peer.imageUrl }} />
        }
        // The policy chooser never freezes the row (it is instant); a resume
        // in flight still does.
        disabled={resume.isPending}
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
            {/* The OTHER owner's answer, only when it says Never: the pair
                stays silent whatever this side picks. */}
            {peer.theirPolicy === "blocked" && (
              <Badge
                variant="outline"
                className="text-muted-foreground shrink-0 font-normal"
              >
                Their side: never
              </Badge>
            )}
            <TriStateControl
              label={`Can ${agentName} and ${peer.name} message each other`}
              options={OPTIONS}
              value={
                peer.myPolicy === "allow"
                  ? "allow"
                  : peer.myPolicy === "blocked"
                    ? "never"
                    : "ask"
              }
              onSelect={(choice) =>
                choose(choice === "allow" ? "allow" : "blocked")
              }
            />
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
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmRemove}
              className={buttonVariants({ variant: "destructive" })}
            >
              Remove
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
