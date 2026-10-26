"use client";

import { useState } from "react";
import { Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import type { PendingActionApprovalItem } from "@/lib/api/channel-approvals";
import { writeErrorToast } from "@/lib/api/write-error-toast";
import {
  useApproveCustomConnection,
  useDecideChannelAction,
} from "@/hooks/use-approvals";
import { formatAge } from "./format-age";
import { HostWithDomain } from "./host-with-domain";

interface CustomConnectionApprovalRowProps {
  item: PendingActionApprovalItem & {
    customConnection: NonNullable<
      PendingActionApprovalItem["customConnection"]
    >;
  };
}

const MASK = "••••••";

/** Client-side guard (the server checks too): only an https docs link is
 * clickable; anything else (javascript:, http:, garbage) is plain text. */
const isHttpsUrl = (url: string) => {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * An agent-proposed custom connection, reviewed and approved WITH the key.
 * The agent researched where and how the key goes; the person checks that
 * in plain words (the host's real domain highlighted, the header rendered
 * with the key masked) and types the key here. The key goes straight to
 * the approve route and is never shown back, stored client-side, or put in
 * the chat. Decline goes through the ordinary decide door.
 */
export const CustomConnectionApprovalRow = ({
  item,
}: CustomConnectionApprovalRowProps) => {
  const proposal = item.customConnection;
  const approve = useApproveCustomConnection(item.agentId);
  const decide = useDecideChannelAction(item.agentId);
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);

  const busy = approve.isPending;
  const hasKey = value.trim().length > 0;
  const headerPreview = `${proposal.headerName}: ${proposal.valueFormat.replace("{value}", MASK)}`;

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
          <p className="text-muted-foreground truncate text-xs">
            {item.agentName} · asks you for an API key
          </p>
        </div>
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {formatAge(item.createdAt)}
        </span>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Sent to</dt>
        <dd className="min-w-0 break-all" data-testid="cc-host">
          <HostWithDomain
            host={proposal.hostPattern}
            domain={proposal.registrableDomain}
          />
          {proposal.pathPattern && (
            <span className="text-muted-foreground font-mono">
              {proposal.pathPattern}
            </span>
          )}
        </dd>
        <dt className="text-muted-foreground">As</dt>
        <dd className="min-w-0 font-mono break-all" data-testid="cc-header">
          {headerPreview}
        </dd>
        {proposal.docsUrl && (
          <>
            <dt className="text-muted-foreground">Docs</dt>
            <dd className="min-w-0 break-all">
              {isHttpsUrl(proposal.docsUrl) ? (
                <a
                  href={proposal.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="focus-visible:ring-ring/50 rounded-sm underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-[3px]"
                >
                  {proposal.docsUrl}
                </a>
              ) : (
                <span data-testid="cc-docs-text">{proposal.docsUrl}</span>
              )}
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Why</dt>
        <dd className="min-w-0 break-words">{proposal.reason}</dd>
      </dl>

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

      <div className="flex items-center justify-end gap-1.5">
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
    </form>
  );
};
