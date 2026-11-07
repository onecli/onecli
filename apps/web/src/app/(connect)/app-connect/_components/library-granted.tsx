"use client";

import { useEffect, useState } from "react";
import { Button } from "@onecli/ui/components/button";
import { LIBRARY_GRANT_MESSAGE } from "@/lib/skills/library-grant-popup";

/**
 * Where "Install GitHub for skills only" lands. No connection was created:
 * the signed grant rides the URL fragment (never sent to a server). Hand it
 * to the opener on this origin only, wipe it from the address bar, close.
 * A browser may refuse to close the window (e.g. it became a tab), so a
 * Close button stays.
 */
export const LibraryGranted = () => {
  const [sent, setSent] = useState<boolean | null>(null);

  useEffect(() => {
    const grant = new URLSearchParams(window.location.hash.slice(1)).get("g");
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    if (!grant || !window.opener) {
      setSent(false);
      return;
    }
    window.opener.postMessage(
      { type: LIBRARY_GRANT_MESSAGE, grant },
      window.location.origin,
    );
    setSent(true);
    window.close();
  }, []);

  return (
    <div className="flex flex-col items-center gap-2 py-4 text-center">
      <p className="text-sm font-medium">
        {sent === false
          ? "Couldn't hand GitHub access back"
          : "GitHub is ready for your skills"}
      </p>
      <p className="text-muted-foreground text-xs">
        {sent === false
          ? "Close this window and try again from the Skills page."
          : "Return to OneCLI to pick the repo."}
      </p>
      <Button size="sm" variant="outline" onClick={() => window.close()}>
        Close
      </Button>
    </div>
  );
};
