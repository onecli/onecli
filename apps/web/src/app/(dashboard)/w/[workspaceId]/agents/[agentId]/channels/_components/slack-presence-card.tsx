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
import { slack as slackApp } from "@onecli/api/apps/slack";
import type { AgentChannelPresence } from "@/lib/api";
import { SlackDetachDialog } from "./slack-detach-dialog";
import { PersonReachRow } from "./person-reach-row";
import { SpaceReachRow } from "./space-reach-row";

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
  // Channels, not threads: several threads can live in one channel, so the
  // raw thread count reads as "2 group threads" for what a person sees as
  // one room. `spaces` is already the deduped per-channel list.
  const channelCount = presence.spaces?.length ?? 0;
  const attention = presence.status === "needs_attention";

  return (
    <>
      <Card className="gap-4">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="bg-card flex size-10 shrink-0 items-center justify-center rounded-xl border shadow-sm">
                <AppIcon icon={slackApp.icon} name={slackApp.name} size={22} />
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
              {presence.status === "disabled" ? (
                <Badge variant="secondary">Disabled</Badge>
              ) : attention ? (
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

          <p className="text-muted-foreground text-sm">
            {threadCount === 0
              ? "Message the bot directly, or mention it in a channel to start a group thread."
              : channelCount > 0
                ? `Active in ${channelCount === 1 ? "1 channel" : `${channelCount} channels`} · ${threadCount === 1 ? "1 thread" : `${threadCount} threads`}.`
                : `Active in ${threadCount === 1 ? "1 group thread" : `${threadCount} group threads`}.`}
          </p>

          {(presence.spaces?.length ?? 0) > 0 && (
            <div className="mt-3 border-t pt-3">
              <p className="mb-0.5 text-xs font-medium">
                Channels · who the agent answers
              </p>
              <p className="text-muted-foreground mb-1 text-xs">
                Open a channel so the agent answers people without OneCLI
                accounts.
              </p>
              <div className="divide-y">
                {(presence.spaces ?? []).map((space) => (
                  <SpaceReachRow
                    key={space.externalRef}
                    agentId={agentId}
                    provider={presence.provider}
                    space={space}
                  />
                ))}
              </div>
            </div>
          )}

          {/* People, in their own section rather than mixed into Channels:
              the two ask different questions (a room's policy vs one
              person's standing), offer different answers (three vs two),
              and the person list grows with every stranger who writes. One
              heading states the kind once, which beats a per-row badge
              beside a badge that is already the menu trigger. */}
          {(presence.people?.length ?? 0) > 0 && (
            <div className="mt-3 border-t pt-3">
              <p className="mb-0.5 text-xs font-medium">
                People · direct messages
              </p>
              <p className="text-muted-foreground mb-1 text-xs">
                People without OneCLI accounts who messaged this agent directly.
              </p>
              <div className="divide-y">
                {(presence.people ?? []).map((person) => (
                  <PersonReachRow
                    key={person.externalRef}
                    agentId={agentId}
                    provider={presence.provider}
                    person={person}
                  />
                ))}
              </div>
            </div>
          )}
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
