"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, Loader2 } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { AgentAvatar } from "@/lib/agents/_components/agent-avatar";
import { agentSectionPath } from "@/lib/navigation";
import { useSlackReadAgents } from "./hooks";

export interface SlackReadAgentsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The workspace-level door to "Connect your Slack": the agents here that
 * have a Slack app, and where YOU stand with each. Connecting stays per agent
 * (each agent reads through its own app, so detaching one never touches
 * another): picking an agent opens its Slack page, where the connect button
 * or the picker is waiting.
 */
export const SlackReadAgentsDialog = ({
  open,
  onOpenChange,
}: SlackReadAgentsDialogProps) => {
  const pathname = usePathname();
  const agents = useSlackReadAgents(open);
  const rows = agents.data?.agents ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Let an agent read your Slack</DialogTitle>
          <DialogDescription className="text-pretty">
            Each agent reads through its own Slack app, so you connect per
            agent. Pick one to connect your Slack and choose the channels and
            messages it can read.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {agents.isPending ? (
            <p className="text-muted-foreground flex items-center gap-2 py-3 text-sm">
              <Loader2
                className="size-3.5 animate-spin motion-reduce:hidden"
                aria-hidden
              />
              Loading agents…
            </p>
          ) : agents.isError ? (
            <div className="flex items-center justify-between gap-2 py-3 text-sm">
              <span className="text-muted-foreground">
                {agents.error instanceof Error
                  ? agents.error.message
                  : "Couldn't load agents."}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => agents.refetch()}
              >
                Try again
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <p className="text-muted-foreground rounded-md border border-dashed px-3 py-4 text-sm text-pretty">
              No agent here has Slack yet. Open an agent, go to its Slack page,
              and add it to Slack first.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {rows.map((a) => (
                <li key={a.agentId}>
                  <Link
                    href={`${agentSectionPath(pathname, a.agentId, "channels")}`}
                    onClick={() => onOpenChange(false)}
                    className="hover:bg-muted flex items-center gap-3 px-3 py-2.5"
                  >
                    <AgentAvatar
                      agent={{ name: a.agentName, imageUrl: a.imageUrl }}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate text-sm font-medium"
                        translate="no"
                      >
                        {a.agentName}
                      </span>
                      <span
                        className="text-muted-foreground block truncate text-xs"
                        translate="no"
                      >
                        {a.handle ? `@${a.handle} in Slack` : "Slack app"}
                      </span>
                    </span>
                    {a.connected ? (
                      <Badge
                        variant="secondary"
                        className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      >
                        {a.sharedByMe === 0
                          ? "Connected"
                          : a.sharedByMe === 1
                            ? "1 shared"
                            : `${a.sharedByMe} shared`}
                      </Badge>
                    ) : a.available ? (
                      <span className="text-muted-foreground text-xs">
                        Connect
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">
                        Needs setup
                      </span>
                    )}
                    <ChevronRight
                      className="text-muted-foreground size-4 shrink-0"
                      aria-hidden
                    />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
