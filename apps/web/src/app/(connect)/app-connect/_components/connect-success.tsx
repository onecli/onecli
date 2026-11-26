"use client";

import { useEffect, useState } from "react";
import { Button } from "@onecli/ui/components/button";
import type { MissingPermission } from "@onecli/api/apps/missing-permissions";
import { MissingPermissionsNotice } from "@/lib/components/missing-permissions-notice";

interface ConnectSuccessProps {
  appName: string;
  appIcon: string;
  provider: string;
  agentName?: string;
  /** The freshly-CREATED connection. It rides the parent notification so the
   * dashboard can open its agent-access dialog for exactly this account —
   * choosing agents happens there, in a full-width dialog, not in this 520px
   * popup. Reconnects and org connects never carry it. */
  connectedId?: string;
  /** Requested permissions the user didn't grant. When set, the window stays
   * open so the user can read why and try again. */
  missingPermissions?: MissingPermission[];
  /** Re-run the consent screen for the same connection. */
  onRetry?: () => void;
}

export const ConnectSuccess = ({
  appName,
  provider,
  agentName,
  connectedId,
  missingPermissions = [],
  onRetry,
}: ConnectSuccessProps) => {
  const partial = missingPermissions.length > 0;
  const [countdown, setCountdown] = useState(agentName ? 8 : 3);

  useEffect(() => {
    // Notify the parent window
    if (window.opener) {
      window.opener.postMessage(
        { type: "app-connected", provider, connectionId: connectedId },
        window.location.origin,
      );
    }

    // A partial grant keeps the window open: the user has something to fix.
    if (partial) return;

    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          window.close();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [provider, connectedId, partial]);

  if (partial) {
    return (
      <div className="flex flex-col items-center gap-4 py-2">
        <p className="text-sm font-medium">{appName} connected</p>
        <MissingPermissionsNotice
          className="w-full"
          permissions={missingPermissions}
          onReconnect={onRetry}
          reconnectLabel="Try again"
        />
        <Button size="sm" variant="ghost" onClick={() => window.close()}>
          Close
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2 py-4">
      <p className="text-sm font-medium">{appName} connected successfully</p>
      {agentName ? (
        <div className="text-muted-foreground text-center text-xs leading-relaxed">
          <p className="line-clamp-1">
            Go back to {agentName}. It will retry automatically.
          </p>
          <p className="text-muted-foreground/60">Closing in {countdown}s</p>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          This window will close in {countdown}s
        </p>
      )}
    </div>
  );
};
