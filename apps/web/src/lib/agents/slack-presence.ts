/**
 * The one law for the "connected to Slack" marks (the agent rail's channels
 * row, the sidebar's agent rows): a presence row exists from the moment a
 * guided attach is clicked (`pending_setup` — resumable, possibly abandoned),
 * so bare row existence is NOT connection. "Connected" draws the same line
 * the Channels section draws for its attached face: any status other than
 * `pending_setup` (`needs_attention` still renders as attached there).
 *
 * A missing `status` (an older API during deploy skew) reads as connected —
 * the pre-status behavior — never as "everything just disconnected".
 */
export const isSlackConnected = (
  channels: readonly { provider: string; status?: string }[] | undefined,
): boolean =>
  channels?.some(
    (c) => c.provider === "slack" && c.status !== "pending_setup",
  ) ?? false;

/** The Slack brand mark as served from /public — the same asset the app
 * registry declares (`packages/api/src/apps/slack.ts`). A local constant so
 * the always-mounted chrome doesn't pull the OAuth-laden app module into its
 * bundle for a path string. */
export const SLACK_ICON_SRC = "/icons/slack.svg";
