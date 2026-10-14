/**
 * Slack's display facts, re-exported for the Slack UI components
 * (`slack-*` cards, the org Slack cards). The generic surfaces read the
 * registry (`channel-providers/registry.ts`) instead; `isPresenceConnected`
 * in `channel-providers.ts` is the one "connected" law.
 */
export { SLACK_DISPLAY_NAME, SLACK_ICON_SRC } from "./channel-providers/slack";

/**
 * Slack's own deep link into a DM with an installed app, pinned to the
 * workspace it lives in: `team=` keeps a multi-workspace user out of their
 * DEFAULT workspace, which may not be the one the agent is in. The one
 * "Open in Slack" href, shared by the agent's Slack card and the org page's
 * agent list.
 */
export const slackAppRedirectUrl = (appId: string, teamId: string): string =>
  `https://slack.com/app_redirect?app=${encodeURIComponent(appId)}&team=${encodeURIComponent(teamId)}`;
