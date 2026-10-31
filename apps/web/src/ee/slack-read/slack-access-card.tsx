"use client";

import { NotSentUndo } from "@/lib/components/approvals/not-sent-undo";
import { useUndoableDismiss } from "@/lib/components/approvals/use-undoable-dismiss";
import { RequestedAtLabel } from "@/lib/components/approvals/requested-at-label";
import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@onecli/ui/components/button";
import { AppIcon } from "@/lib/components/app-icon";
import { openInstallPopup } from "@/lib/agents/install-popup";
import { useDecideChannelAction } from "@/hooks/use-approvals";
import { queryKeys } from "@/lib/api/keys";
import type {
  PendingActionApprovalItem,
  SlackAccessView,
} from "@/lib/api/channel-approvals";
import { useStartSlackConnect, useSlackReadConnection } from "./hooks";

export interface SlackAccessCardProps {
  item: PendingActionApprovalItem & { slackAccess: SlackAccessView };
}

const CONNECT_REASONS: ReadonlySet<SlackAccessView["reason"]> = new Set([
  "not_connected",
  "reconnect_for_write",
]);

/** How often the card checks whether the Connect popup was closed, and how
 * long it keeps watching (the OAuth return settles the request server-side;
 * the pending list then drops the card). */
const POPUP_POLL_MS = 1_000;
const POPUP_WATCH_MS = 3 * 60 * 1_000;

/**
 * "Let the agent act as you in Slack": the card read_conversation /
 * send_as_me raise (needs_access) when the person asking in their own chat
 * hasn't connected, hasn't shared the conversation, or has writing off.
 * Its words are the server's summary, never the agent's text. Connect
 * reasons open the Slack consent popup (the request settles when connect
 * completes; the card then says Connected or asks to try again); Not now
 * rejects the request. The rest are Allow / Not now through the decide door.
 */
type ConnectState = "idle" | "waiting" | "connected" | "failed";

export const SlackAccessCard = ({ item }: SlackAccessCardProps) => {
  const qc = useQueryClient();
  const decide = useDecideChannelAction(item.agentId);
  const start = useStartSlackConnect(item.agentId);
  const connection = useSlackReadConnection(item.agentId);
  const isConnect = CONNECT_REASONS.has(item.slackAccess.reason);
  const reconnect = item.slackAccess.reason === "reconnect_for_write";
  const [state, setState] = useState<ConnectState>("idle");
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanup.current?.(), []);

  /** Ask the server whether the connect actually landed (the popup's word
   * alone is not proof), then settle the card and refresh what changed:
   * the pending list (the server settled the request) and this agent's
   * act-as-you data. */
  const verify = async () => {
    const { data: conn, isError } = await connection.refetch();
    const ok =
      !isError &&
      conn !== undefined &&
      conn.connected &&
      (!reconnect || conn.canWrite);
    setState(ok ? "connected" : "failed");
    if (ok) cleanup.current?.();
    void qc.invalidateQueries({ queryKey: queryKeys.approvals.all() });
    void qc.invalidateQueries({
      queryKey: queryKeys.channels.slackRead(item.agentId),
    });
  };

  const watch = (popup: Window | null) => {
    cleanup.current?.();
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data: unknown = event.data;
      if (
        typeof data === "object" &&
        data !== null &&
        "type" in data &&
        data.type === "app-connected" &&
        "provider" in data &&
        data.provider === "slack-read"
      ) {
        void verify();
      }
    };
    // The popup's message can be lost (opener cut, closed by hand): the
    // window regaining focus, or the popup closing, re-checks too.
    const onFocus = () => void verify();
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (popup?.closed) {
        window.clearInterval(timer);
        void verify();
      } else if (Date.now() - startedAt > POPUP_WATCH_MS) {
        window.clearInterval(timer);
      }
    }, POPUP_POLL_MS);
    window.addEventListener("message", onMessage);
    window.addEventListener("focus", onFocus);
    cleanup.current = () => {
      window.clearInterval(timer);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("focus", onFocus);
      cleanup.current = null;
    };
  };

  const connect = () => {
    // Opened inside the click so no popup blocker eats it.
    const popup = openInstallPopup();
    setState("waiting");
    start.mutate(undefined, {
      onSuccess: ({ authorizeUrl }) => {
        if (popup) popup.location.href = authorizeUrl;
        else window.location.href = authorizeUrl;
        watch(popup);
      },
      onError: (err) => {
        popup?.close();
        setState("idle");
        toast.error(err instanceof Error ? err.message : "Couldn't start");
      },
    });
  };

  const { dismissed, dismiss, undo } = useUndoableDismiss(() =>
    decide.mutate({ approvalId: item.id, decision: "reject" }),
  );

  const connectLabel = reconnect ? "Reconnect Slack" : "Connect Slack";
  if (dismissed) return <NotSentUndo onUndo={undo} />;

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="bg-muted flex size-7 shrink-0 items-center justify-center rounded-md border dark:border-white/10 dark:bg-white/10">
          <AppIcon icon="/icons/slack.svg" name="Slack" size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-pretty">{item.summary}</p>
          <p className="text-muted-foreground text-xs" aria-live="polite">
            {state === "connected"
              ? "Connected. The agent continues on its own."
              : state === "failed"
                ? "Didn't connect, try again."
                : isConnect
                  ? "Only you can connect your Slack. You choose what it may read or send."
                  : "Only you can allow this. You can change it later in Contacts."}
          </p>
        </div>
        <RequestedAtLabel createdAt={item.createdAt} />
      </div>
      <div className="flex items-center gap-1.5">
        {isConnect ? (
          state === "connected" ? (
            <span className="flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-500">
              <Check className="size-3.5" aria-hidden />
              Connected
            </span>
          ) : (
            <>
              <Button
                variant="link"
                size="xs"
                className="text-muted-foreground mr-auto px-0"
                onClick={dismiss}
                disabled={decide.isPending}
              >
                Not now
              </Button>
              <Button
                size="xs"
                onClick={connect}
                disabled={start.isPending || state === "waiting"}
              >
                {start.isPending || state === "waiting" ? (
                  <>
                    <Loader2
                      className="size-3.5 animate-spin motion-reduce:hidden"
                      aria-hidden
                    />
                    Connecting…
                  </>
                ) : state === "failed" ? (
                  "Try again"
                ) : (
                  connectLabel
                )}
              </Button>
            </>
          )
        ) : (
          <>
            <Button
              variant="link"
              size="xs"
              className="text-muted-foreground mr-auto px-0"
              onClick={dismiss}
            >
              Not now
            </Button>
            <Button
              size="xs"
              onClick={() =>
                decide.mutate({ approvalId: item.id, decision: "approve" })
              }
            >
              {item.slackAccess.kind === "write" ? "Allow write" : "Allow read"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
};
