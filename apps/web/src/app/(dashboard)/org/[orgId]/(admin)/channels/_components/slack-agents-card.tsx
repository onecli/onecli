"use client";

import { Skeleton } from "@onecli/ui/components/skeleton";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { useOrgChannelAgents } from "@/hooks/use-org-channels";
import type { OrgChannelAgent } from "@/lib/api";
import { SlackAgentRow } from "./slack-agent-row";

export interface SlackAgentsCardProps {
  /** The Slack workspace's display name, when known. */
  workspaceName: string | null;
}

/** Work first: the agents waiting on a click, then the ones not added,
 * then the ones already in Slack. Within a group, the server's order. */
const RANK: Record<OrgChannelAgent["state"], number> = {
  pending: 0,
  attention: 1,
  none: 2,
  active: 3,
};

/**
 * The payoff of connecting Slack: every hosted agent in the org, each one
 * click from Slack. The header answers "how many are in, and what's left",
 * agents waiting on a click sort to the top, and OneCLI workspaces only show
 * as headings when there is more than one.
 */
export const SlackAgentsCard = ({ workspaceName }: SlackAgentsCardProps) => {
  // No popup listener here: the Slack row above already turns the install
  // popup's app-connected message into a refetch of every channels query
  // (this list's key included) and its toast.
  const { data, isPending, isError } = useOrgChannelAgents("slack");
  const workspaces = (data?.workspaces ?? [])
    .filter((w) => w.agents.length > 0)
    .map((w) => ({
      ...w,
      agents: [...w.agents].sort((a, b) => RANK[a.state] - RANK[b.state]),
    }));
  const all = workspaces.flatMap((w) => w.agents);
  const inSlack = all.filter((a) => a.state === "active").length;
  const where = workspaceName ?? "your Slack workspace";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <CardTitle>Your agents</CardTitle>
            <CardDescription className="mt-1.5">
              Click{" "}
              <span className="text-foreground font-medium">Add to Slack</span>{" "}
              and approve in the Slack window. The agent then shows up in{" "}
              <span translate="no">{where}</span> with its own name, ready to
              message.
            </CardDescription>
          </div>
          {all.length > 0 && (
            <p className="text-muted-foreground shrink-0 text-sm tabular-nums">
              {inSlack} of {all.length} in Slack
            </p>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : isError || !data ? (
          <p className="text-muted-foreground text-sm">
            Couldn&apos;t load your agents. Refresh to try again.
          </p>
        ) : all.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No hosted agents yet. Create one, then add it to Slack from here.
          </p>
        ) : (
          <div className="space-y-5">
            {workspaces.map((workspace) => {
              const label = `${workspace.name ?? "Untitled"} workspace`;
              return (
                <section key={workspace.id} aria-label={label}>
                  {workspaces.length > 1 && (
                    // The page's only heading above this is its h1 (the
                    // card title is a div), so the group heading is h2.
                    <h2 className="text-muted-foreground mb-1 text-sm">
                      {label}
                    </h2>
                  )}
                  <ul className="divide-y">
                    {workspace.agents.map((agent) => (
                      <SlackAgentRow
                        key={agent.id}
                        workspaceId={workspace.id}
                        agent={agent}
                        transport={data.posture.transport}
                      />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
