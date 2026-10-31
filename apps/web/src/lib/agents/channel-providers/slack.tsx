/**
 * Slack's entry in the dashboard's channel-provider registry: display facts
 * and the two cards the agent's Channels section mounts. Everything
 * Slack-shaped in the agent-facing channel UI is reachable from here and
 * from the `slack-*` components it names — the generic surfaces (the
 * section, the rail mark, the sidebar mark) never import them directly.
 */
import { SlackAttachCard } from "@/app/(dashboard)/w/[workspaceId]/agents/[agentId]/channels/_components/slack-attach-card";
import { SlackActAsYouLink } from "@/app/(dashboard)/w/[workspaceId]/agents/[agentId]/channels/_components/slack-act-as-you-link";
import { SlackPresenceCard } from "@/app/(dashboard)/w/[workspaceId]/agents/[agentId]/channels/_components/slack-presence-card";
import type { ChannelProviderUi } from "../channel-providers";

/** The Slack brand mark as served from /public, and the display name —
 * every Slack card and mark reads them from this one place. */
export const SLACK_ICON_SRC = "/icons/slack.svg";
export const SLACK_DISPLAY_NAME = "Slack";

/** Slack's deep link into one channel (docs.slack.dev, "Deep linking into
 * Slack"): `team=` pins it to the workspace the channel lives in, so a
 * multi-workspace user does not land in their default workspace's 404. */
const slackChannelUrl = (channelId: string, teamId: string): string =>
  `https://slack.com/app_redirect?channel=${encodeURIComponent(channelId)}&team=${encodeURIComponent(teamId)}`;

export const slackProviderUi: ChannelProviderUi = {
  id: "slack",
  name: SLACK_DISPLAY_NAME,
  iconSrc: SLACK_ICON_SRC,
  channelUrl: slackChannelUrl,
  PresenceCard: SlackPresenceCard,
  AttachCard: SlackAttachCard,
  ReadAccessCard: SlackActAsYouLink,
};
