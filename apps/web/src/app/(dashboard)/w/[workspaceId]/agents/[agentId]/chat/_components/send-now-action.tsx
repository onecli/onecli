"use client";

import { bareToolName } from "@onecli/agent-protocol/activity";
import { Button } from "@onecli/ui/components/button";
import { Loader2 } from "lucide-react";
import { useSendNow } from "@/hooks/use-conversations";
import type { SentNowOutcome } from "@/lib/chat/transcript";

/**
 * SEND NOW, on the status line of a message sent while the
 * agent works: a message that would otherwise wait for the tool the agent
 * is running (a long build, a slow command) is read right away instead,
 * the tool moving to the background.
 *
 * Every state says only what is known: the click is a request
 * ("Sending now…", then "Asked to read it now" once the API took it), and
 * the agent's own answer replaces it when it lands: what was moved, or
 * that nothing was running to move. Never "read" before the agent read
 * it: that is the row flipping to `joined`, which drops this line.
 *
 * Mounted for as long as the message could be sent now, not only while a
 * tool runs: the move itself ends the tool, and the agent's answer may
 * land a moment after that, so the request's state must outlive the
 * button. Renders nothing between tools when nothing was asked.
 *
 * SECURITY: `outcome.toolName` is untrusted sandbox text, rendered as text
 * only, bounded on screen.
 */
export const SendNowAction = ({
  followUpId,
  conversationId,
  toolRunning,
  outcome,
}: {
  followUpId: string;
  conversationId: string;
  /** The run is inside a tool right now: the only time the button helps. */
  toolRunning: boolean;
  /** The agent's answer, from the live stream. */
  outcome?: SentNowOutcome;
}) => {
  const sendNow = useSendNow(conversationId);

  if (outcome) {
    return (
      <span role="status">
        {outcome.moved ? (
          <>
            Moved{" "}
            {outcome.toolName ? (
              <span className="inline-block max-w-40 truncate align-bottom font-mono">
                {bareToolName(outcome.toolName)}
              </span>
            ) : (
              "the running step"
            )}{" "}
            to the background, reading it now
          </>
        ) : (
          "Nothing to move, it'll be read after this step"
        )}
      </span>
    );
  }

  if (sendNow.isSuccess) {
    return <span role="status">Asked to read it now</span>;
  }

  if (!toolRunning && !sendNow.isPending) return null;

  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      className="text-muted-foreground hover:text-foreground h-auto p-0 text-xs"
      disabled={sendNow.isPending}
      onClick={() => sendNow.mutate(followUpId)}
    >
      {sendNow.isPending ? (
        <>
          <Loader2 className="animate-spin" aria-hidden />
          Sending now…
        </>
      ) : (
        "Send now"
      )}
    </Button>
  );
};
