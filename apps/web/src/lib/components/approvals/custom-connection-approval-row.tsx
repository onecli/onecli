"use client";

import { useState } from "react";
import { CircleHelp, Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import type { PendingActionApprovalItem } from "@/lib/api/channel-approvals";
import { writeErrorToast } from "@/lib/api/write-error-toast";
import {
  useApproveCustomConnection,
  useDecideChannelAction,
} from "@/hooks/use-approvals";
import { RequestedAtLabel } from "./requested-at-label";

interface CustomConnectionApprovalRowProps {
  item: PendingActionApprovalItem & {
    customConnection: NonNullable<
      PendingActionApprovalItem["customConnection"]
    >;
  };
  /** The bell lists every agent's asks; the chat thread is one agent's. The
   * new key is switched on for the asking agent, so the bell names it. */
  showAgent?: boolean;
}

/** OneCLI's own guide, never the agent's docs link: nothing the agent chose
 * is clickable on this card. */
const CUSTOM_CONNECTIONS_DOCS_URL =
  "https://onecli.sh/docs/integrations/custom-connections";

/**
 * An agent-proposed custom connection, reviewed and approved WITH the key.
 * Kept short on purpose: the app's name, the real domain the key is sent
 * to, the key field, and OneCLI's guide behind "Need help?". The key goes
 * straight to the approve route and is never shown back, stored
 * client-side, or put in the chat. Decline goes through the ordinary decide
 * door.
 */
export const CustomConnectionApprovalRow = ({
  item,
  showAgent = false,
}: CustomConnectionApprovalRowProps) => {
  const proposal = item.customConnection;
  const approve = useApproveCustomConnection(item.agentId);
  const decide = useDecideChannelAction(item.agentId);
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);

  const busy = approve.isPending;
  const hasKey = value.trim().length > 0;

  const onApprove = () =>
    approve.mutate(
      { approvalId: item.id, value },
      {
        onSuccess: (outcome) => {
          setValue("");
          if (outcome.status === "executed") {
            toast.success(`Connected ${proposal.name}. The agent was told.`);
          } else {
            toast.error("Approved, but it failed. The agent was told.");
          }
        },
        // No Retry: a retry would have to keep the key around to resend it.
        // The key stays in the field, so fixing it and approving again is the
        // retry.
        onError: (err) =>
          writeErrorToast(`Couldn't connect ${proposal.name}`, err),
        // Drop the observer's copy of the variables (the key) too, so the
        // gcTime-0 mutation leaves the cache now, not when the card unmounts.
        onSettled: () => approve.reset(),
      },
    );

  // Instant, like every bell decision: the card leaves on click, and the
  // hook says the outcome (or puts the card back) when the server answers.
  const onDecline = () =>
    decide.mutate({ approvalId: item.id, decision: "reject" });

  return (
    <form
      className="flex flex-col gap-3 px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (hasKey && !busy) onApprove();
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <KeyRound aria-hidden="true" className="size-4 shrink-0" />
            Connect {proposal.name}?
          </p>
          {showAgent && (
            <p className="text-muted-foreground truncate text-xs">
              <span translate="no">{item.agentName}</span> · asks you for an API
              key
            </p>
          )}
        </div>
        <RequestedAtLabel createdAt={item.createdAt} />
      </div>

      <p className="text-foreground text-xs" data-testid="cc-destination">
        Your key will be sent to{" "}
        <strong>{proposal.registrableDomain ?? proposal.hostPattern}</strong>
      </p>

      <div className="flex items-center gap-1.5">
        <Input
          type={reveal ? "text" : "password"}
          aria-label={`${proposal.name} API key`}
          placeholder="Paste the API key here, not in the chat…"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
          className="h-8 font-mono text-xs"
        />
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={reveal ? "Hide key" : "Show key"}
          onClick={() => setReveal((r) => !r)}
        >
          {reveal ? (
            <EyeOff aria-hidden="true" className="size-4" />
          ) : (
            <Eye aria-hidden="true" className="size-4" />
          )}
        </Button>
      </div>

      <div className="flex items-center justify-between gap-1.5">
        <Button asChild variant="ghost" size="xs">
          <a
            href={CUSTOM_CONNECTIONS_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground"
          >
            <CircleHelp aria-hidden="true" className="size-3.5" />
            Need help?
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </Button>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={onDecline}
          >
            Decline
          </Button>
          <Button type="submit" size="xs" disabled={!hasKey || busy}>
            {approve.isPending ? (
              <>
                <Loader2
                  aria-hidden="true"
                  className="size-3 animate-spin motion-reduce:hidden"
                />
                Connecting…
              </>
            ) : (
              "Approve"
            )}
          </Button>
        </div>
      </div>
    </form>
  );
};
