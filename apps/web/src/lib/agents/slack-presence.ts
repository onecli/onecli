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

/**
 * An app's Basic Information page on api.slack.com: where its app-level token
 * is generated and "Install to Workspace" lives. The one href for a known
 * app id, shared by the guided socket steps and the paste floor's reconnect.
 */
export const slackAppSettingsUrl = (appId: string): string =>
  `https://api.slack.com/apps/${encodeURIComponent(appId)}/general`;

/** The same page scrolled to its "Display Information" card, where the app's
 * profile icon is set. Slack's page has no anchor for that card (a `#display`
 * link opened at the top), so this is a text fragment. It targets the card's
 * "App icon & Preview" label, not its heading: the browser centres the match,
 * so aiming at the heading left the card half below the fold, while this
 * brings the card up and highlights where the icon is uploaded. A browser
 * without text fragments just opens the page. */
const SLACK_ICON_SETTINGS_FRAGMENT = "#:~:text=App%20icon%20%26%20Preview";

export const slackAppIconSettingsUrl = (appId: string): string =>
  `${slackAppSettingsUrl(appId)}${SLACK_ICON_SETTINGS_FRAGMENT}`;
