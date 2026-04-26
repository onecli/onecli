"use client";

import { useEffect, useState } from "react";

interface ConnectSuccessProps {
  appName: string;
  appIcon: string;
  provider: string;
  agentName?: string;
}

export const ConnectSuccess = ({
  appName,
  provider,
  agentName,
}: ConnectSuccessProps) => {
  const [countdown, setCountdown] = useState(agentName ? 8 : 3);

  useEffect(() => {
    // Notify the parent window
    if (window.opener) {
      window.opener.postMessage(
        { type: "app-connected", provider },
        window.location.origin,
      );
    }

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
  }, [provider]);

  return (
    <div className="flex flex-col items-center gap-2 py-4">
      <p className="text-sm font-medium">{appName} connected successfully</p>
      {agentName ? (
        <div className="text-xs text-muted-foreground text-center leading-relaxed">
          <p className="line-clamp-1">
            Go back to {agentName}. It will retry automatically.
          </p>
          <p className="text-muted-foreground/60">Closing in {countdown}s</p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          This window will close in {countdown}s
        </p>
      )}
    </div>
  );
};
