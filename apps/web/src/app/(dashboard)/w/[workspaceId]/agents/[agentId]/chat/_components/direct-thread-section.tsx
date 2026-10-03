"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { MAX_JOINING_FOLLOW_UPS } from "@onecli/api/validations/conversation";
import { queryKeys } from "@/lib/api/keys";
import { ApiError } from "@/lib/api/client";
import {
  activeTurn,
  isJoiningTurn,
  resendableKeylessTurn,
} from "@/lib/chat/turns";
import {
  useAbortTurn,
  useDirectConversation,
  useSendMessage,
} from "@/hooks/use-conversations";
import { useUploadAttachment } from "@/hooks/use-attachments";
import { useConversationTranscript } from "@/hooks/use-conversation-transcript";
import { useHostedAvailability } from "@/hooks/use-hosted-availability";
import { usePathname } from "next/navigation";
import { agentSectionPath } from "@/lib/navigation";
import { useAgentPageAgent } from "../../_components/agent-page-frame";
import { EmptyState } from "../../_components/empty-state";
import { useCreateThenAttachSecret } from "@/hooks/use-create-then-attach-secret";
import { SecretDialog } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/secret-dialog";
import type { TurnsPage } from "@/lib/api";
import { ChatThread } from "./chat-thread";
import { Composer } from "./composer";
import { OfflineBanner } from "./offline-banner";

const ThreadSkeleton = () => (
  <div className="flex-1 space-y-4 p-6">
    <Skeleton className="ms-auto h-10 w-1/2 rounded-lg" />
    <Skeleton className="h-16 w-2/3 rounded-lg" />
    <Skeleton className="ms-auto h-10 w-1/3 rounded-lg" />
  </div>
);

/**
 * The direct thread (§3.18): the agent IS the conversation, materialized on
 * mount through the idempotent get-or-create door. The stream is the
 * transcript's single source (it replays history before tailing); the turns
 * poll is the source for turn STATE, because some failures never reach the
 * stream. No header — the agent page above already says who this is, and the
 * frame guarantees this agent is hosted.
 *
 * This is also where the availability poll lives (30s on the shared instance
 * query), so the offline banner recovers on its own when the agents come
 * back. `loading` renders the normal frame: it must never read as
 * unavailable.
 */
export const DirectThreadSection = () => {
  const qc = useQueryClient();
  const agent = useAgentPageAgent();
  const agentId = agent.id;
  const pathname = usePathname();
  const availability = useHostedAvailability({ poll: true });

  const direct = useDirectConversation(agentId);
  const conversationId = direct.data?.id;

  // The READ half (rows, transcript, stream, history) is the shared hook;
  // this section owns the WRITE half beneath it.
  const transcript = useConversationTranscript(conversationId);
  const { turnsQuery, turns, folded, stream } = transcript;
  const sendMessage = useSendMessage(conversationId ?? "");
  const abortTurn = useAbortTurn(conversationId ?? "");
  const uploadAttachment = useUploadAttachment(conversationId ?? "");
  const active = activeTurn(turns);

  // In-place model-key door for the no_model_key notice: the shared
  // create-then-attach seam, mounted OVER the chat so fixing the gap never
  // navigates away from the conversation. Once the key attaches, the message
  // that failed for lack of one is re-sent so the agent answers the thing
  // the user already asked. Turns are read FRESH from the cache — two awaits
  // pass between the save click and the attach settling, so a render-time
  // closure would be stale — and `resendableKeylessTurn` holds the guards
  // (the user's own newest turn only, no attachments, nothing running).
  // Known-accepted: React Query drops mutate callbacks after unmount, so
  // navigating away mid-attach skips the resend; the notice still offers
  // the manual path.
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const { secretActions: keySecretActions, onSaved: onKeySaved } =
    useCreateThenAttachSecret(agentId, {
      onAttached: () => {
        if (conversationId === undefined) return;
        const fresh =
          qc.getQueryData<TurnsPage>(
            queryKeys.conversations.turns(conversationId),
          )?.turns ?? [];
        const failed = resendableKeylessTurn(fresh);
        if (failed) {
          sendMessage.mutate({ message: failed.message });
          return;
        }
        // No resend fired (files on the failed turn, something running, an
        // older question) — the attach still worked, and silence here would
        // read as failure. Say so; name the manual step when files are why.
        const lastOwn = [...fresh]
          .reverse()
          .find((turn) => turn.userId !== null);
        toast.success(
          (lastOwn?.errorCode === "no_model_key" ||
            lastOwn?.errorCode === "trial_credit_exhausted") &&
            lastOwn.attachments.length > 0
            ? "Model key connected. Re-send your message to include its files."
            : "Model key connected.",
        );
      },
    });

  // The cap refusal ("give me a moment to catch up") describes a STATE — a
  // full parked backlog — so it clears itself once that state passes. The
  // latch waits until the backlog has been SEEN full and then drained:
  // resetting the moment the count reads low would wipe the note before the
  // invalidated refetch even lands (this cache can be stale at the instant
  // the 409 arrives — the cap may have been filled from another door).
  const capRefused =
    sendMessage.error instanceof ApiError && sendMessage.error.status === 409;
  const capSeenBacklogRef = useRef(false);
  const { reset: resetSend } = sendMessage;
  const parkedCount = useMemo(
    () => (turnsQuery.data?.turns ?? []).filter(isJoiningTurn).length,
    [turnsQuery.data],
  );
  useEffect(() => {
    if (!capRefused) {
      capSeenBacklogRef.current = false;
      return;
    }
    if (parkedCount >= MAX_JOINING_FOLLOW_UPS) {
      capSeenBacklogRef.current = true;
    } else if (capSeenBacklogRef.current) {
      capSeenBacklogRef.current = false;
      resetSend(); // the backlog drained — the note is now stale
    }
  }, [capRefused, parkedCount, resetSend]);

  // The thread self-heals if its conversation vanishes underneath it (a 404
  // from the stream or the turns poll): invalidate the door's key ONCE so a
  // fresh row materializes. State, not a ref — the guard also decides what
  // renders when healing didn't help. It keeps a persistently-404ing door
  // (the agent itself deleted — the frame will catch up) from looping.
  const conversationGone =
    stream.error?.httpStatus === 404 ||
    (turnsQuery.error instanceof ApiError && turnsQuery.error.status === 404);
  const [healedOnce, setHealedOnce] = useState(false);
  useEffect(() => {
    if (!conversationGone || healedOnce) return;
    setHealedOnce(true);
    qc.invalidateQueries({
      queryKey: queryKeys.conversations.direct(agentId),
    });
  }, [conversationGone, healedOnce, agentId, qc]);

  // The optimistic user row riding the send/refetch seam: what was typed
  // (plus the staged files' local previews), on screen from mutate until the
  // poll delivers the real row (an ordinary turn or a follow-up — both
  // arrive as rows on the turns key).
  const pending =
    sendMessage.isPending ||
    (sendMessage.isSuccess &&
      !turns.some((t) => t.id === sendMessage.data.turn.id))
      ? sendMessage.variables
      : undefined;

  // Everything the thread renders sits in the same frame, so the offline
  // banner is written once rather than per branch.
  const frame = (children: React.ReactNode) => (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {availability === "offline" && <OfflineBanner />}
      {children}
    </div>
  );

  if (availability === "absent") {
    // Deep link on a deployment with no hosted agents (the rail never showed
    // this section). Honest and quiet — never a crash.
    return <EmptyState tone="quiet" title="Chat isn't available here yet." />;
  }

  if (conversationGone && healedOnce) {
    // The self-heal already ran and the thread still 404s — stop guessing.
    return frame(
      <EmptyState
        title="This conversation no longer exists."
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setHealedOnce(false);
              qc.invalidateQueries({
                queryKey: queryKeys.conversations.direct(agentId),
              });
            }}
          >
            Start fresh
          </Button>
        }
      />,
    );
  }

  if (direct.isError || (stream.status === "error" && !conversationGone)) {
    const retry = direct.isError
      ? () => direct.refetch()
      : () => window.location.reload();
    return frame(
      <EmptyState
        title="The conversation didn't load."
        description={
          direct.isError ? direct.error.message : stream.error?.message
        }
        action={
          <Button variant="outline" size="sm" onClick={retry}>
            Try again
          </Button>
        }
      />,
    );
  }

  // The door hasn't answered yet — there is nothing to send to, so the
  // composer waits with the thread rather than accepting a doomed message.
  if (conversationId === undefined) return frame(<ThreadSkeleton />);

  const transcriptLoading = transcript.loading;

  return frame(
    <>
      {transcriptLoading ? (
        <ThreadSkeleton />
      ) : (
        <ChatThread
          turns={turns}
          folded={folded}
          pending={pending}
          conversationId={conversationId}
          modelsHref={agentSectionPath(pathname, agentId, "models")}
          agentName={agent.name}
          agentId={agentId}
          onConnectModelKey={() => setKeyDialogOpen(true)}
          hasOlder={transcript.hasOlder}
          loadingOlder={transcript.loadingOlder}
          onLoadOlder={transcript.loadOlder}
        />
      )}

      <SecretDialog
        open={keyDialogOpen}
        onOpenChange={setKeyDialogOpen}
        onSaved={onKeySaved}
        allowedTypes={["anthropic", "openai"]}
        secretActions={keySecretActions}
      />

      {stream.status === "reconnecting" && (
        <p className="text-muted-foreground animate-pulse px-4 py-1 text-center text-xs">
          Reconnecting…
        </p>
      )}

      <Composer
        onSend={(outgoing) => sendMessage.mutate(outgoing)}
        uploadFile={(file) => uploadAttachment.mutateAsync(file)}
        sendPending={sendMessage.isPending}
        sendError={sendMessage.error}
        failedDraft={
          sendMessage.isError ? sendMessage.variables.message : undefined
        }
        failedAttachments={
          sendMessage.isError ? sendMessage.variables.attachments : undefined
        }
        onStop={active ? () => abortTurn.mutate(active.id) : undefined}
        stopPending={abortTurn.isPending}
        autoFocus
      />
    </>,
  );
};
