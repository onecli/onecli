import { escapeSlackText } from "@onecli/channels/slack";
import {
  clampHeader,
  clampLabel,
  conversationsOpen,
  postBlocksMessage,
  updateBlocksMessage,
} from "@onecli/channels/slack";
import { parseSlackPresenceCredentials } from "./types";

/**
 * The Slack rendering of the one-shot ACTION-approval card — "the agent
 * wants to do X, may it?". The generic action-approval service reaches it
 * only through the provider registry's `actionApprovalCard` facet. The
 * reach-card discipline verbatim: template text is OURS, every dynamic
 * field escaped and clamped, button values carry ONLY the opaque approval
 * id. The summary is platform-composed by the REQUESTING service, but it
 * may embed model-chosen fragments (a message preview), so it gets the
 * same neutralize-and-clamp treatment as a subject label.
 *
 * Reason capture is dashboard-only in v1 (Slack buttons cannot carry text;
 * the modal flow is a recorded follow-up) — the card says so.
 */

export const ACTION_APPROVE_ACTION = "action_approve";
export const ACTION_APPROVE_ALWAYS_ACTION = "action_approve_always";
export const ACTION_REJECT_ACTION = "action_reject";

/** Click vocabulary for the inbound interactivity routes — one place, both
 * arms read it (the REACH_ACTION_DECISIONS idiom). */
export const ACTION_APPROVAL_DECISIONS: Record<
  string,
  "approve" | "approve_always" | "reject"
> = {
  [ACTION_APPROVE_ACTION]: "approve",
  [ACTION_APPROVE_ALWAYS_ACTION]: "approve_always",
  [ACTION_REJECT_ACTION]: "reject",
};

/** A summary may embed model-chosen text: break leading directive tokens
 * the way the reach card neutralizes chosen labels. */
const neutralizeSummary = (raw: string): string =>
  raw.replace(/^([!/@#])/, "\u2060$1");

export const actionApprovalCardBlocks = (input: {
  approvalId: string;
  agentName: string;
  summary: string;
  /** Offer the "always allow" upgrade — only for actions whose registration
   * declares a standing-grant hook (the service asks the registry). */
  offerAlwaysAllow?: boolean;
}): unknown[] => {
  const agent = clampHeader(escapeSlackText(input.agentName));
  const summary = clampLabel(neutralizeSummary(escapeSlackText(input.summary)));
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Approval \u00b7 ${clampHeader(input.agentName)}`,
        emoji: false,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `${agent} asks: *${summary}*\n` +
          `_Nothing happens until you decide. To reject with a reason, use` +
          ` the dashboard \u2014 the reason is passed back to ${agent}._`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Approve", emoji: false },
          action_id: ACTION_APPROVE_ACTION,
          value: input.approvalId,
        },
        // The standing upgrade, between the one-shots: approve THIS send
        // and stop asking about this recipient. Unstyled on purpose - the
        // durable choice must not look like the default.
        ...(input.offerAlwaysAllow
          ? [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "Approve + always allow",
                  emoji: false,
                },
                action_id: ACTION_APPROVE_ALWAYS_ACTION,
                value: input.approvalId,
              },
            ]
          : []),
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "Reject", emoji: false },
          action_id: ACTION_REJECT_ACTION,
          value: input.approvalId,
        },
      ],
    },
  ];
};

const settledText = (input: {
  summary: string;
  outcome: string;
  decidedByName: string;
}): string => {
  const summary = clampLabel(neutralizeSummary(escapeSlackText(input.summary)));
  const by = escapeSlackText(input.decidedByName);
  switch (input.outcome) {
    case "executed":
      return `\u2705 *${summary}* - approved by ${by} and done.`;
    case "rejected":
      return `\u26d4 *${summary}* - rejected by ${by}.`;
    case "failed":
      return `\u26a0\ufe0f *${summary}* - approved by ${by}, but it FAILED. The agent was told.`;
    case "expired":
      return `*${summary}* - expired without an answer. The agent can ask again.`;
    default:
      return `*${summary}* - ${escapeSlackText(input.outcome)}.`;
  }
};

/** The provider facet (`ChannelProvider.actionApprovalCard`). */
export const slackActionApprovalCard = {
  async post(input: {
    credentialsJson: string;
    recipientExternalUserId: string;
    approvalId: string;
    agentName: string;
    summary: string;
    offerAlwaysAllow?: boolean;
  }): Promise<{ channel: string; ts: string }> {
    const creds = parseSlackPresenceCredentials(input.credentialsJson);
    if (!creds.botToken) throw new Error("presence has no bot token");
    const im = await conversationsOpen(
      creds.botToken,
      input.recipientExternalUserId,
    );
    const posted = await postBlocksMessage(creds.botToken, {
      channel: im.channel.id,
      text: `${input.agentName} asks for approval: ${input.summary}`,
      blocks: actionApprovalCardBlocks(input),
    });
    return { channel: posted.channel, ts: posted.ts };
  },

  async settle(input: {
    credentialsJson: string;
    channel: string;
    ts: string;
    summary: string;
    outcome: string;
    decidedByName: string;
  }): Promise<void> {
    const creds = parseSlackPresenceCredentials(input.credentialsJson);
    if (!creds.botToken) return;
    const text = settledText(input);
    await updateBlocksMessage(creds.botToken, {
      channel: input.channel,
      ts: input.ts,
      text,
      blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
    });
  },
};
