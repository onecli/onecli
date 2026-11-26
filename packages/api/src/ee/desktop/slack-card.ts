import {
  clampHeader,
  clampLabel,
  conversationsOpen,
  escapeSlackText,
  postBlocksMessage,
  updateBlocksMessage,
} from "@onecli/channels/slack";
import { parseSlackPresenceCredentials } from "../../services/channels/providers/slack/types";

/**
 * The Slack rendering of the desktop TAKEOVER card: "the agent needs you
 * on its screen". The generic desktop
 * service reaches it only through the provider registry's
 * `desktopRequestCard` facet. The reach-card discipline verbatim: template
 * text is OURS, every dynamic field escaped and clamped, and the one button
 * is a URL button to the dashboard's Computer section. Its URL carries an
 * opaque request id, never a capability: the dashboard requires the
 * person's own session and fences the agent to their workspace.
 *
 * No decision buttons: the decision IS taking control, made on the screen.
 * Slack still posts a `block_actions` payload for a URL button click; the
 * inbound route's default 200 is the ack (the browser already opened the
 * URL), the shared-app onboarding button's precedent.
 */

export const DESKTOP_OPEN_ACTION = "desktop_open";

/** The reason is the model's words, already made inert by the service
 * (`plainReason`): no links, no markup. Escaped again here for Slack's
 * mrkdwn, and a leading directive token broken like a chosen label. */
const neutralizeReason = (raw: string): string =>
  raw.replace(/^([!/@#])/, "\u2060$1");

export const desktopRequestCardBlocks = (input: {
  agentName: string;
  reason: string;
  url: string;
}): unknown[] => {
  const agent = clampHeader(escapeSlackText(input.agentName));
  const reason = clampLabel(neutralizeReason(escapeSlackText(input.reason)));
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${agent}* needs you on its screen: ${reason}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Open computer", emoji: false },
          url: input.url,
          action_id: DESKTOP_OPEN_ACTION,
        },
      ],
    },
  ];
};

export const settledDesktopCardText = (input: {
  reason: string;
  outcome: "done" | "timeout" | "expired";
  handledByName: string | null;
}): string => {
  const reason = clampLabel(neutralizeReason(escapeSlackText(input.reason)));
  const by = input.handledByName ? escapeSlackText(input.handledByName) : null;
  switch (input.outcome) {
    case "done":
      return by
        ? `\u2705 ${by} took over and is done: ${reason}`
        : `\u2705 Done: ${reason}`;
    case "timeout":
      return by
        ? `${by}’s control of the screen timed out: ${reason}`
        : `Control of the screen timed out: ${reason}`;
    case "expired":
      return `Expired: ${reason}`;
  }
};

/** The provider facet (`ChannelProvider.desktopRequestCard`). */
export const slackDesktopRequestCard = {
  async post(input: {
    credentialsJson: string;
    recipientExternalUserId: string;
    agentName: string;
    reason: string;
    url: string;
  }): Promise<{ channel: string; ts: string }> {
    const creds = parseSlackPresenceCredentials(input.credentialsJson);
    if (!creds.botToken) throw new Error("presence has no bot token");
    const im = await conversationsOpen(
      creds.botToken,
      input.recipientExternalUserId,
    );
    const posted = await postBlocksMessage(creds.botToken, {
      channel: im.channel.id,
      text: `${input.agentName} needs you on its screen: ${input.reason}`,
      blocks: desktopRequestCardBlocks(input),
      noUnfurl: true,
    });
    return { channel: posted.channel, ts: posted.ts };
  },

  async settle(input: {
    credentialsJson: string;
    channel: string;
    ts: string;
    reason: string;
    outcome: "done" | "timeout" | "expired";
    handledByName: string | null;
  }): Promise<void> {
    const creds = parseSlackPresenceCredentials(input.credentialsJson);
    if (!creds.botToken) return;
    const text = settledDesktopCardText(input);
    await updateBlocksMessage(creds.botToken, {
      channel: input.channel,
      ts: input.ts,
      text,
      blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
    });
  },
};
