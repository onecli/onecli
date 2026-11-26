"use client";

import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useNewestScheduleRun } from "@/hooks/use-runs";
import { RunDetailSheet } from "@/lib/agents/runs";

/**
 * The Last run cell as a button: opens the schedule's newest run (still
 * going or done) in the same side panel Activity uses, which follows a live
 * run until it finishes. The run is looked up on click, so the list
 * itself carries no turn IDs.
 */
export const LastRunLink = ({
  agentId,
  cronId,
  children,
}: {
  agentId: string;
  cronId: string;
  children: ReactNode;
}) => {
  const [turnId, setTurnId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const newestRun = useNewestScheduleRun(agentId, cronId);

  const open = () => {
    if (loading) return;
    setLoading(true);
    newestRun()
      .then((newest) => {
        if (newest) setTurnId(newest);
        else toast.info("This run is not in the history yet");
      })
      .catch(() => toast.error("Couldn't open the last run"))
      .finally(() => setLoading(false));
  };

  return (
    <>
      <button
        type="button"
        onClick={open}
        aria-busy={loading}
        className="hover:text-foreground flex min-w-0 items-center gap-1.5 rounded text-left underline-offset-4 hover:underline"
      >
        {children}
      </button>
      <RunDetailSheet
        agentId={agentId}
        turnId={turnId}
        onOpenChange={(isOpen) => {
          if (!isOpen) setTurnId(null);
        }}
      />
    </>
  );
};
