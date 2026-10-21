"use client";

import { useState } from "react";
import {
  Hash,
  Loader2,
  Lock,
  MessageCircle,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Unplug,
  UserRound,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { openInstallPopup } from "@/lib/agents/install-popup";
import {
  useDisconnectSlack,
  useSlackReadConnection,
  useSlackReadGrants,
  useStartSlackConnect,
} from "./hooks";
import { ReadGrantRow } from "./read-grant-row";
import { ReadSection } from "./read-section";
import { SlackIdentity } from "./slack-identity";
import { AddReadGrantDialog } from "./add-read-grant-dialog";

export interface SlackReadCardProps {
  agentId: string;
  agentName: string;
}

/**
 * "What {agent} can read" (licensed: granular_access). People connect their
 * OWN Slack (read-only) and pick conversations they are in - channels,
 * private channels, DMs - for the agent to read, each with who may ask about
 * it. The list shows every grant on the agent with who granted it; the
 * connect/disconnect and the picker act only on the viewer's own Slack.
 */
export const SlackReadCard = ({ agentId, agentName }: SlackReadCardProps) => {
  const connection = useSlackReadConnection(agentId);
  const grants = useSlackReadGrants(agentId);
  const start = useStartSlackConnect(agentId);
  const disconnect = useDisconnectSlack(agentId);
  const [addOpen, setAddOpen] = useState(false);

  const connected = connection.data?.connected ?? false;
  const available = connection.data?.available ?? false;
  const rows = grants.data?.grants ?? [];

  const connect = () => {
    // Opened inside the click (the gesture), pointed at Slack once the
    // authorize URL arrives, so no popup blocker eats it.
    const popup = openInstallPopup();
    start.mutate(undefined, {
      onSuccess: ({ authorizeUrl }) => {
        if (popup) popup.location.href = authorizeUrl;
        else window.location.href = authorizeUrl;
      },
      onError: (err) => {
        popup?.close();
        toast.error(err instanceof Error ? err.message : "Couldn't start");
      },
    });
  };

  const channelRows = rows.filter(
    (g) => g.subjectKind === "channel" || g.subjectKind === "private_channel",
  );
  const messageRows = rows.filter(
    (g) => g.subjectKind === "dm" || g.subjectKind === "group_dm",
  );

  const runDisconnect = () =>
    disconnect.mutate(undefined, {
      onSuccess: () =>
        toast.success("Disconnected. Everything you shared was removed."),
      onError: (err) =>
        toast.error(err instanceof Error ? err.message : "Disconnect failed"),
    });

  return (
    <>
      <Card className="gap-5">
        <CardHeader>
          <CardTitle>What {agentName} can read</CardTitle>
          <CardDescription className="text-pretty">
            {agentName} only sees messages sent to it, plus the conversations
            people share here. It reads with their Slack and never posts.
          </CardDescription>
          {connected && rows.length > 0 && (
            <CardAction>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAddOpen(true)}
              >
                <Plus className="size-3.5" aria-hidden />
                Add conversations
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="space-y-6">
          <ReadSection icon={UserRound} title="Your Slack" bare>
            {connection.isPending ? (
              <Skeleton className="h-14 w-full" />
            ) : connected ? (
              <div className="flex items-center gap-3 rounded-md border px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <SlackIdentity profile={connection.data?.profile ?? null} />
                </div>
                <Badge
                  variant="secondary"
                  className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                >
                  Connected
                </Badge>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild disabled={disconnect.isPending}>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="More for your Slack"
                    >
                      {disconnect.isPending ? (
                        <Loader2
                          className="size-4 animate-spin motion-reduce:hidden"
                          aria-hidden
                        />
                      ) : (
                        <MoreHorizontal className="size-4" aria-hidden />
                      )}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={runDisconnect}
                      className="items-start"
                    >
                      <Unplug className="mt-0.5 size-4" aria-hidden />
                      <span>
                        <span className="block">Disconnect my Slack</span>
                        <span className="text-muted-foreground block text-xs text-pretty">
                          Also stops sharing everything you shared.
                        </span>
                      </span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-3">
                <p className="text-muted-foreground text-sm text-pretty">
                  {available
                    ? "Connect your Slack (read-only) to share your own channels and messages."
                    : "This agent's Slack app can't connect personal accounts. Re-attach it with the guided setup."}
                </p>
                <Button
                  size="sm"
                  onClick={connect}
                  disabled={!available || start.isPending}
                >
                  {start.isPending ? (
                    <>
                      <Loader2
                        className="size-3.5 animate-spin motion-reduce:hidden"
                        aria-hidden
                      />
                      Connecting…
                    </>
                  ) : (
                    "Connect your Slack"
                  )}
                </Button>
              </div>
            )}
          </ReadSection>

          {grants.isError ? (
            <div className="flex items-center gap-3">
              <p className="text-muted-foreground text-sm">
                Shared conversations didn&apos;t load.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => grants.refetch()}
              >
                Try again
              </Button>
            </div>
          ) : grants.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-md border border-dashed px-4 py-6 text-center">
              <MessageSquare
                className="text-muted-foreground size-5"
                aria-hidden
              />
              <p className="text-sm font-medium">Nothing shared yet</p>
              <p className="text-muted-foreground max-w-sm text-xs text-pretty">
                {connected
                  ? `Pick channels or messages you're in. You choose who can ask ${agentName} about each one.`
                  : "Once you connect, you can pick channels or messages you're in."}
              </p>
              {connected && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-1"
                  onClick={() => setAddOpen(true)}
                >
                  <Plus className="size-3.5" aria-hidden />
                  Add conversations
                </Button>
              )}
            </div>
          ) : (
            <>
              <ReadSection
                icon={Hash}
                title="Channels"
                count={channelRows.length}
                description="Public and private channels shared with the agent."
                empty="No channels shared."
              >
                {channelRows.map((grant) => (
                  <ReadGrantRow
                    key={grant.id}
                    agentId={agentId}
                    grant={grant}
                  />
                ))}
              </ReadSection>
              <ReadSection
                icon={MessageCircle}
                title="Direct messages"
                count={messageRows.length}
                description="One-on-one and group messages shared with the agent."
                empty="No direct messages shared."
              >
                {messageRows.map((grant) => (
                  <ReadGrantRow
                    key={grant.id}
                    agentId={agentId}
                    grant={grant}
                  />
                ))}
              </ReadSection>
              <p className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                <span className="inline-flex items-center gap-1">
                  <Lock className="size-3" aria-hidden />
                  <span className="text-foreground">Only me</span>: only you can
                  ask the agent to read it, and it may remember what it read.
                </span>
                <span className="inline-flex items-center gap-1">
                  <Users className="size-3" aria-hidden />
                  <span className="text-foreground">Anyone</span> answers anyone
                  the agent talks to.
                </span>
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <AddReadGrantDialog
        agentId={agentId}
        agentName={agentName}
        open={addOpen}
        onOpenChange={setAddOpen}
        grantedRefs={rows.map((g) => g.externalRef)}
      />
    </>
  );
};
