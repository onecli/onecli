"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { AppIcon } from "@/lib/components/app-icon";
import {
  SLACK_DISPLAY_NAME,
  SLACK_ICON_SRC,
} from "@/lib/agents/slack-presence";
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
 * amber fix. A `disabled` presence (removed on the Slack side) is NOT this
 * card's business: the section routes it to the attach card's removed face.
 */
export const SlackPresenceCard = ({
  agentId,
  agentName,
  presence,
  hasOrgCredentials,
}: SlackPresenceCardProps) => {
  const [detachOpen, setDetachOpen] = useState(false);
  const workspace = presence.tenant.name ?? presence.tenant.externalId;
  const attention = presence.status === "needs_attention";

  return (
    <>
      <Card className="gap-4">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="bg-card flex size-10 shrink-0 items-center justify-center rounded-xl border shadow-sm">
                <AppIcon
                  icon={SLACK_ICON_SRC}
                  name={SLACK_DISPLAY_NAME}
                  size={22}
                />
              </span>
              <div className="min-w-0 space-y-0.5">
                <CardTitle className="truncate leading-tight">
                  {presence.identityName
                    ? `@${presence.identityName}`
                    : `${agentName} @ ${workspace}`}
                </CardTitle>
                <CardDescription className="truncate">
                  {presence.managedBy
                    ? `Managed by ${
                        presence.managedBy.name?.trim() ||
                        presence.managedBy.email
                      }`
                    : workspace}
                </CardDescription>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {attention ? (
                <Badge
                  variant="secondary"
                  className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                >
                  <span className="size-1.5 rounded-full bg-amber-500" />
                  Needs attention
                </Badge>
              ) : (
                <Badge
                  variant="secondary"
                  className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                >
                  <span className="size-1.5 rounded-full bg-emerald-500" />
                  Connected
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {attention && (
            <div className="mb-3 space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 dark:border-amber-500/40 dark:bg-amber-500/15">
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

          {/* This card is the APP: its identity, health, and the detach
              door. Where the agent is reachable (channels, people) and who
              it answers there live on the agent's Contacts page (PR 5b),
              including the room counts that used to sit here. */}
          <p className="text-muted-foreground text-sm">
            Message the bot directly, or mention it in a channel to start a
            group thread.
          </p>
        </CardContent>
        <CardFooter className="justify-between gap-2 border-t [.border-t]:pt-4">
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
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => setDetachOpen(true)}
          >
            Detach
          </Button>
        </CardFooter>
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
