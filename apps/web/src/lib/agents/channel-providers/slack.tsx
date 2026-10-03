/**
 * Slack's entry in the dashboard's channel-provider registry: display facts
 * and the two cards the agent's Channels section mounts. Everything
 * Slack-shaped in the agent-facing channel UI is reachable from here and
 * from the `slack-*` components it names — the generic surfaces (the
 * section, the rail mark, the sidebar mark) never import them directly.
 */
import { SlackAttachCard } from "@/app/(dashboard)/w/[workspaceId]/agents/[agentId]/channels/_components/slack-attach-card";
import { SlackPresenceCard } from "@/app/(dashboard)/w/[workspaceId]/agents/[agentId]/channels/_components/slack-presence-card";
import type { ChannelProviderUi } from "../channel-providers";

/** The Slack brand mark as served from /public, and the display name —
 * every Slack card and mark reads them from this one place. */
export const SLACK_ICON_SRC = "/icons/slack.svg";
export const SLACK_DISPLAY_NAME = "Slack";

export const slackProviderUi: ChannelProviderUi = {
  id: "slack",
  name: SLACK_DISPLAY_NAME,
  iconSrc: SLACK_ICON_SRC,
  PresenceCard: SlackPresenceCard,
  AttachCard: SlackAttachCard,
};
