"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { useConversationTranscript } from "@/hooks/use-conversation-transcript";
import { PairThread } from "./pair-thread";

interface PeerConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  /** This agent: its messages are the dark bubbles. */
  agentName: string;
  /** The peer: its messages are the white bubbles. */
  peerName: string;
  /** THIS side is past the turn cap: the thread says so at its end. */
  paused: boolean;
}

/**
 * The pair conversation between this agent and a peer, READ-ONLY, as a
 * plain two-agent chat (`PairThread`): fed by the same transcript hook the
 * direct chat uses (live window, bounded-replay stream, scroll-up history),
 * with no Composer - a person watches this thread, the agents write it.
 * Mounted only while open, so the stream and queries cost nothing until
 * someone looks.
 */
export const PeerConversationDialog = ({
  open,
  onOpenChange,
  conversationId,
  agentName,
  peerName,
  paused,
}: PeerConversationDialogProps) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex h-[min(80dvh,720px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
      <DialogHeader className="border-b px-6 py-4">
        <DialogTitle>
          <span translate="no">{agentName}</span> and{" "}
          <span translate="no">{peerName}</span>
        </DialogTitle>
        <DialogDescription>Read only.</DialogDescription>
      </DialogHeader>
      {open && (
        <PeerThread
          conversationId={conversationId}
          agentName={agentName}
          peerName={peerName}
          paused={paused}
        />
      )}
    </DialogContent>
  </Dialog>
);

const PeerThread = ({
  conversationId,
  agentName,
  peerName,
  paused,
}: {
  conversationId: string;
  agentName: string;
  peerName: string;
  paused: boolean;
}) => {
  const transcript = useConversationTranscript(conversationId);
  if (transcript.loading) {
    return (
      <div className="flex-1 space-y-4 p-6">
        <Skeleton className="h-16 w-2/3 rounded-lg" />
        <Skeleton className="ms-auto h-10 w-1/2 rounded-lg" />
        <Skeleton className="h-16 w-2/3 rounded-lg" />
      </div>
    );
  }
  if (transcript.stream.status === "error") {
    return (
      <p className="text-muted-foreground flex-1 p-6 text-sm">
        The conversation didn&apos;t load.
        {transcript.stream.error?.message
          ? ` ${transcript.stream.error.message}`
          : ""}
      </p>
    );
  }
  return (
    <PairThread
      agentName={agentName}
      peerName={peerName}
      turns={transcript.turns}
      folded={transcript.folded}
      paused={paused}
      hasOlder={transcript.hasOlder}
      loadingOlder={transcript.loadingOlder}
      onLoadOlder={transcript.loadOlder}
    />
  );
};
