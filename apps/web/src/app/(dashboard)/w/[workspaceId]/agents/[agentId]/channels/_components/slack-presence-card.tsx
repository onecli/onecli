"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import type { AgentChannelPresence } from "@/lib/api";
import { SlackDetachDialog } from "./slack-detach-dialog";

interface SlackPresenceCardProps {
  agentId: string;
  agentName: string;
  presence: AgentChannelPresence;
  hasOrgCredentials: boolean;
}

/**
 * The attached face of the Slack card: who the bot is, how its events arrive,
 * where to open it, and the detach door. `needs_attention` keeps the whole
 * card — messaging still works; only the approval bridge is broken — plus the
 * amber fix.
 */
export const SlackPresenceCard = ({
  agentId,
  agentName,
  presence,
  hasOrgCredentials,
}: SlackPresenceCardProps) => {
  const [detachOpen, setDetachOpen] = useState(false);
  const workspace = presence.tenant.name ?? presence.tenant.externalId;
  const threadCount = presence.groupThreads.length;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="truncate">
                {agentName} @ {workspace}
              </CardTitle>
              <CardDescription>Slack</CardDescription>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Badge variant="secondary" className="capitalize">
                {presence.transport === "events" ? "Events" : "Socket"}
              </Badge>
              {presence.status === "disabled" && (
                <Badge variant="secondary">Disabled</Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {presence.status === "needs_attention" && (
            <div className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 dark:border-amber-500/40 dark:bg-amber-500/15">
              <p className="text-sm">
                Approvals for this agent stopped working: its service key was
                refused (the member who attached it may have lost workspace
                access). Detach and re-attach to fix.
              </p>
              <p className="text-muted-foreground text-xs">
                Everything else keeps working.
              </p>
            </div>
          )}

          <p className="text-muted-foreground text-sm">
            {threadCount === 0
              ? "No group threads yet. Mention the agent in a channel to start one."
              : threadCount === 1
                ? "Active in 1 group thread."
                : `Active in ${threadCount} group threads.`}
          </p>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <a
                // `team=` pins the redirect to the installed workspace — without it a
                // multi-workspace user lands in their DEFAULT workspace, which may
                // not be the one the agent lives in.
                href={`https://slack.com/app_redirect?app=${encodeURIComponent(presence.externalId)}&team=${encodeURIComponent(presence.tenant.externalId)}`}
                target="_blank"
                rel="noreferrer"
              >
                Open in Slack
                <ExternalLink className="size-3.5" />
              </a>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => setDetachOpen(true)}
            >
              Detach
            </Button>
          </div>
        </CardContent>
      </Card>

      <SlackDetachDialog
        agentId={agentId}
        open={detachOpen}
        onOpenChange={setDetachOpen}
        // Remote deletion runs on the org automation credential — without one
        // there is nothing to offer.
        canDeleteRemote={hasOrgCredentials}
        identityName={presence.identityName}
      />
    </>
  );
};
