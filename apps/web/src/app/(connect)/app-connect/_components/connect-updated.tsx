"use client";

import { useEffect, useState } from "react";
import { Button } from "@onecli/ui/components/button";

export interface ConnectUpdatedProps {
  appName: string;
}

/**
 * The installation was changed on the provider's side (e.g. repos added to a
 * GitHub App) with no connect in flight. Nothing new was stored: say so,
 * then close (the opener refreshes its lists when it regains focus). A
 * browser may refuse to close a window it didn't open as a popup, so there
 * is a Close button and a line saying the tab can be closed.
 */
export const ConnectUpdated = ({ appName }: ConnectUpdatedProps) => {
  const [countdown, setCountdown] = useState(3);

  useEffect(() => {
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
  }, []);

  return (
    <div className="flex flex-col items-center gap-2 py-4 text-center">
      <p className="text-sm font-medium">{appName} access updated</p>
      <p className="text-muted-foreground text-xs">
        {countdown > 0
          ? `This window will close in ${countdown}s`
          : "You can close this window and return to OneCLI."}
      </p>
      <Button size="sm" variant="outline" onClick={() => window.close()}>
        Close
      </Button>
    </div>
  );
};
