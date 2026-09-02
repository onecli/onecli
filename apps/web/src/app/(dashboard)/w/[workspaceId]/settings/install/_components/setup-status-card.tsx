"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAgentDetail } from "@/hooks/use-agents";
import { withWorkspacePrefix } from "@/lib/navigation";

// One honest live signal: the agent's first gateway request. "CLI installed"
// stages are deliberately absent — their only server signal is workspace-level
// and first-run-only, while install failures are already visible in the
// user's own terminal.
export const SetupStatusCard = ({
  agent,
}: {
  agent: { id: string; name: string } | undefined;
}) => {
  const pathname = usePathname();
  const { data: detail, isError } = useAgentDetail(agent?.id ?? "", {
    poll: true,
  });

  // An errored detail read means the agent is gone (deleted mid-wait) — hide
  // rather than show a waiting state that can never resolve; the agents-list
  // refresh resets the selection to the first agent.
  if (!agent || isError) return null;

  const live = Boolean(detail?.recentRequestAt);

  return (
    <div className="rounded-lg border p-4">
      <p className="text-sm font-medium">Setup status</p>
      <div
        className="mt-3 flex items-center gap-2.5 text-sm"
        aria-live="polite"
      >
        {live ? (
          <>
            <span className="bg-brand size-2 shrink-0 rounded-full" />
            <span>
              <span className="font-medium">{agent.name}</span> is live:{" "}
              <Link
                href={withWorkspacePrefix(pathname, "/activity")}
                className="text-brand font-medium hover:underline"
              >
                view activity
              </Link>
              {" · "}
              <Link
                href={withWorkspacePrefix(pathname, "/agents")}
                className="text-brand font-medium hover:underline"
              >
                manage agent
              </Link>
            </span>
          </>
        ) : (
          <>
            <span className="bg-brand size-2 shrink-0 animate-pulse rounded-full motion-reduce:animate-none" />
            <span className="text-muted-foreground">
              Waiting for a request from{" "}
              <span className="text-foreground font-medium">{agent.name}</span>.
              Run the command above.
            </span>
          </>
        )}
      </div>
    </div>
  );
};
