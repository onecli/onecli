"use client";

import { Check, Copy, ExternalLink, Lock } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import type { SandboxPortShare } from "@/lib/api";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

export interface PortRowProps {
  port: number;
  /** Something is accepting connections on the port right now. */
  listening: boolean;
  /** The live share, if the port is shared. */
  share: SandboxPortShare | undefined;
  /** Which single action is in flight on this row, if any. */
  busy: "share" | "unshare" | null;
  onShare: () => void;
  onUnshare: () => void;
}

/**
 * One port. The number is the anchor; one status word with a dot carries the
 * live state; the share (when any) is the second line. "Idle" rather than
 * "not running": a shared port with no service yet is a normal state (shared
 * ahead of time, or the service restarting), not a fault. "Private" is a
 * quiet visible word, not a tooltip: it then reads the same by eye, by
 * keyboard, and by screen reader, and the section header already says what
 * private means. Actions are the webhook row's quiet ghost cluster; Copy
 * confirms in place ("Copied" + check) instead of raising a toast.
 */
export const PortRow = ({
  port,
  listening,
  share,
  busy,
  onShare,
  onUnshare,
}: PortRowProps) => {
  const { copied, copy } = useCopyToClipboard();
  return (
    <li className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-sm font-semibold tabular-nums">
            {port}
          </span>
          <span
            className={cn(
              "flex items-center gap-1.5 text-xs",
              listening
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-muted-foreground",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                listening ? "bg-emerald-500" : "bg-muted-foreground/40",
              )}
            />
            {listening ? "listening" : "idle"}
          </span>
          {share && (
            <span className="text-muted-foreground flex items-center gap-1 text-xs">
              <Lock className="size-3" aria-hidden />
              private
            </span>
          )}
        </div>
        {share && (
          <a
            href={share.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary mt-1 flex min-w-0 items-center gap-1 text-xs hover:underline"
          >
            <span className="truncate" translate="no">
              {share.hostname}
            </span>
            <ExternalLink className="size-3 shrink-0" aria-hidden />
          </a>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {share ? (
          <>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void copy(share.url)}
              aria-label={`Copy link for port ${port}`}
            >
              {copied ? (
                <Check className="text-brand size-3.5" aria-hidden />
              ) : (
                <Copy className="size-3.5" aria-hidden />
              )}
              {copied ? "Copied" : "Copy link"}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground hover:text-destructive"
              onClick={onUnshare}
              loading={busy === "unshare"}
              disabled={busy !== null}
              aria-label={`Stop sharing port ${port}`}
            >
              {busy === "unshare" ? "Stopping…" : "Stop sharing"}
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            size="xs"
            onClick={onShare}
            loading={busy === "share"}
            disabled={busy !== null}
            aria-label={`Share port ${port}`}
          >
            {busy === "share" ? "Sharing…" : "Share"}
          </Button>
        )}
      </div>
    </li>
  );
};
