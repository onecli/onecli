"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { AppIcon } from "@/lib/components/app-icon";
import { useAgentChannels } from "@/hooks/use-channels";
import { connectedPresences } from "@/lib/agents/channel-providers";
import { channelProviderUi } from "@/lib/agents/channel-providers/registry";
import { slackAppRedirectUrl } from "@/lib/agents/slack-presence";
import { agentPagePath } from "@/lib/navigation";

/**
 * The top bar's left chip: where else this agent is reachable. With a
 * connected Slack app, "Open in Slack" deep-links to the DM; without one,
 * "Add to Slack" opens the agent's Contacts page, whose first block is
 * Slack. Only for hosted agents (a BYO agent has no Slack presence), and
 * only once the agent's channels are known: a chip that flips from Add to
 * Open after paint would mislead.
 */
export const SlackChip = ({
  workspaceId,
  agent,
}: {
  workspaceId: string;
  agent: { id: string; name: string; kind: string };
}) => {
  // A BYO agent has no channels: the API refuses the read (422), so it is
  // never asked.
  const hosted = agent.kind === "hosted";
  const { data: view } = useAgentChannels(hosted ? agent.id : "");
  const slack = channelProviderUi("slack");
  if (!hosted || !slack || !view) return null;
  const presence = connectedPresences(view.presences).find(
    (p) => p.provider === "slack",
  );
  if (presence) {
    return (
      <Button variant="outline" size="sm" className="rounded-full" asChild>
        <a
          href={slackAppRedirectUrl(
            presence.externalId,
            presence.tenant.externalId,
          )}
          target="_blank"
          rel="noreferrer"
          title={
            presence.identityName
              ? `Opens your DM with @${presence.identityName} in Slack`
              : "Opens your DM with this agent in Slack"
          }
        >
          <AppIcon icon={slack.iconSrc} name={slack.name} size={14} />
          Open in Slack
          <ExternalLink className="text-muted-foreground size-3" aria-hidden />
        </a>
      </Button>
    );
  }
  return (
    <Button
      variant="outline"
      size="sm"
      className="text-muted-foreground rounded-full"
      asChild
    >
      {/* No #slack jump: Slack is the first block on Contacts, and the jump
          scrolled the page's own header out of view. */}
      <Link href={agentPagePath(workspaceId, agent.id, "contacts")}>
        <AppIcon icon={slack.iconSrc} name={slack.name} size={14} />
        Add to Slack
      </Link>
    </Button>
  );
};
