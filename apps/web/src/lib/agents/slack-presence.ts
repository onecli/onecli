/**
 * Slack's display facts, re-exported for the Slack UI components
 * (`slack-*` cards, the org Slack cards). The generic surfaces read the
 * registry (`channel-providers/registry.ts`) instead; `isPresenceConnected`
 * in `channel-providers.ts` is the one "connected" law.
 */
export { SLACK_DISPLAY_NAME, SLACK_ICON_SRC } from "./channel-providers/slack";
