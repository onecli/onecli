"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";

/**
 * The small refresh next to "Running now": reloads the list to see whether
 * the run finished. It spins for at least a beat, so a fast answer doesn't
 * flicker, and can't be pressed again until the check is done.
 */
export const CheckRunButton = ({
  refetch,
}: {
  refetch: () => Promise<unknown>;
}) => {
  const [checking, setChecking] = useState(false);
  const check = () => {
    setChecking(true);
    void Promise.all([
      refetch(),
      new Promise((resolve) => setTimeout(resolve, 600)),
    ]).finally(() => setChecking(false));
  };
  return (
    <button
      type="button"
      aria-label="Check if it finished"
      title="Check if it finished"
      disabled={checking}
      onClick={check}
      className="hover:text-foreground shrink-0 rounded p-0.5"
    >
      <RefreshCw
        className={cn("size-3", checking && "animate-spin")}
        aria-hidden
      />
    </button>
  );
};
