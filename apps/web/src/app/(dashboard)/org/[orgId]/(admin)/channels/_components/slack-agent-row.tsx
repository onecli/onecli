"use client";

import { useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  CircleAlert,
  Clock,
  ExternalLink,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import { AgentAvatar } from "@/lib/agents/_components/agent-avatar";
import { slackAppRedirectUrl } from "@/lib/agents/slack-presence";
import { useAttachAgentFromOrg } from "@/hooks/use-org-channels";
import { openInstallPopup } from "@/lib/agents/install-popup";
import type { ChannelTransport, OrgChannelAgent } from "@/lib/api";

export interface SlackAgentRowProps {
  workspaceId: string;
  agent: OrgChannelAgent;
  /** What a fresh add would be stamped with (the server's posture). */
  transport: ChannelTransport;
}

/** The agent's own Slack page, where everything past "in Slack" lives. */
const agentSlackHref = (workspaceId: string, agentId: string) =>
  `/w/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/channels`;

/**
 * The one line under the name, in words, and the ONE action that moves the
 * agent forward. Decided together so a state can never say one thing and
 * offer another:
 *
 * - `active`: quiet. Open in Slack + Settings.
 * - `attention`: Fix, on the agent's page.
 * - `pending` on events: "Finish in Slack" re-mints the consent URL in a
 *   popup (the guided create resumes the pending app). Slack never tells us
 *   a request is waiting on an admin, so the line names that case too.
 * - `pending` on socket, or `none` on a socket posture: the install needs
 *   tokens pasted on the agent's own page, so the action is a link there.
 *   A blind create from here would mint an app the reader then has to go
 *   find.
 * - `none` on events: "Add to Slack", the click this page exists for.
 */
const statusOf = (
  agent: OrgChannelAgent,
  transport: ChannelTransport,
): {
  Icon: typeof CheckCircle2 | null;
  className: string;
  text: string;
  action: "open" | "fix" | "install" | "finish-on-page" | "set-up-on-page";
} => {
  switch (agent.state) {
    case "active":
      return {
        Icon: CheckCircle2,
        className: "text-emerald-700 dark:text-emerald-400",
        text: "In Slack. Message it or mention",
        action: "open",
      };
    case "attention":
      return {
        Icon: CircleAlert,
        className: "text-amber-700 dark:text-amber-400",
        text: "Not working right now. Check its Slack page.",
        action: "fix",
      };
    case "pending":
      return agent.pendingTransport === "socket"
        ? {
            Icon: Clock,
            className: "text-amber-700 dark:text-amber-400",
            text: "Not finished. Paste its tokens on its Slack page.",
            action: "finish-on-page",
          }
        : {
            Icon: Clock,
            className: "text-amber-700 dark:text-amber-400",
            text: "Not finished. Click Finish in Slack, or wait for your Slack admin to approve.",
            action: "install",
          };
    case "none":
      return {
        Icon: null,
        className: "text-muted-foreground",
        text: "Not in Slack yet.",
        action: transport === "socket" ? "set-up-on-page" : "install",
      };
  }
};

/**
 * One agent on the org Channels page: its face, where it stands in plain
 * words, and the one action that moves it forward. "Add to Slack" and
 * "Finish in Slack" are the same click (the guided create resumes a pending
 * app with a fresh consent URL), opened in a popup the same way the agent's
 * own Slack card does.
 */
export const SlackAgentRow = ({
  workspaceId,
  agent,
  transport,
}: SlackAgentRowProps) => {
  const attach = useAttachAgentFromOrg("slack");
  // Set only when the popup was blocked even inside the click: the URL is
  // then offered as a plain link (a fresh gesture the blocker allows).
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  const status = statusOf(agent, transport);
  const pageHref = agentSlackHref(workspaceId, agent.id);

  const install = () => {
    setBlockedUrl(null);
    const popup = openInstallPopup();
    attach.mutate(
      { workspaceId, agentId: agent.id },
      {
        onSuccess: (result) => {
          if (!result.installUrl) {
            // The server stamped a transport with no consent click (the
            // posture moved under us): the agent's own page carries the
            // guided steps.
            popup?.close();
            toast.message(`Finish ${agent.name}'s setup on its Slack page.`);
            return;
          }
          if (popup) {
            popup.location.href = result.installUrl;
          } else {
            setBlockedUrl(result.installUrl);
          }
        },
        onError: (err) => {
          popup?.close();
          toast.error(err.message);
        },
      },
    );
  };

  return (
    <li className="flex items-center gap-3 py-3">
      <AgentAvatar agent={agent} className="size-9 rounded-full" />
      <div className="min-w-0 flex-1" aria-live="polite">
        <p className="truncate text-sm font-medium" title={agent.name}>
          {agent.name}
        </p>
        {blockedUrl ? (
          <a
            href={blockedUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs underline underline-offset-2"
          >
            Your browser blocked the Slack window. Open it here
          </a>
        ) : (
          <p
            className={cn("flex items-center gap-1 text-xs", status.className)}
          >
            {status.Icon && (
              <status.Icon className="size-3.5 shrink-0" aria-hidden />
            )}
            <span className="truncate">
              {status.text}
              {status.action === "open" && (
                // Live: the agent's real Slack handle, so the reader knows
                // the exact @ to type (it can differ from the OneCLI name).
                <>
                  {" "}
                  <code
                    className="bg-emerald-500/10 rounded px-1 font-mono"
                    translate="no"
                  >
                    @{agent.slack?.handle ?? agent.name}
                  </code>
                </>
              )}
            </span>
          </p>
        )}
      </div>
      {status.action === "open" ? (
        // Done rows stay QUIET: two low-key links, so the eye goes to the
        // agents that still need Add to Slack.
        <div className="flex shrink-0 items-center gap-1">
          {agent.slack && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              asChild
            >
              <a
                href={slackAppRedirectUrl(
                  agent.slack.appId,
                  agent.slack.teamId,
                )}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink className="size-3.5" aria-hidden />
                Open in Slack
              </a>
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            asChild
          >
            <Link href={pageHref}>Settings</Link>
          </Button>
        </div>
      ) : status.action === "fix" ? (
        <Button variant="outline" size="sm" className="shrink-0" asChild>
          <Link href={pageHref}>Fix</Link>
        </Button>
      ) : status.action === "finish-on-page" ? (
        <Button size="sm" className="shrink-0" asChild>
          <Link href={pageHref}>Finish setup</Link>
        </Button>
      ) : status.action === "set-up-on-page" ? (
        <Button size="sm" className="shrink-0" asChild>
          <Link href={pageHref}>
            <Plus className="size-3.5" aria-hidden />
            Set up
          </Link>
        </Button>
      ) : (
        // The action this page exists for: a solid primary button.
        <Button
          size="sm"
          className="shrink-0"
          onClick={install}
          loading={attach.isPending}
        >
          {!attach.isPending && <Plus className="size-3.5" aria-hidden />}
          {attach.isPending
            ? "Opening Slack…"
            : agent.state === "pending"
              ? "Finish in Slack"
              : "Add to Slack"}
        </Button>
      )}
    </li>
  );
};
