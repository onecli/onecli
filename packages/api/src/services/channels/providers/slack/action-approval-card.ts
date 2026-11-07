import { ACTION_CHOICE_PREFIX, actionChoiceOf } from "@onecli/agent-protocol";
import { escapeSlackText } from "@onecli/channels/slack";
import {
  clampHeader,
  clampLabel,
  conversationsOpen,
  postBlocksMessage,
  updateBlocksMessage,
} from "@onecli/channels/slack";
import type { ActionDecision } from "../../action-approval-service";
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
 * the modal flow is a recorded follow-up).
 */

export const ACTION_APPROVE_ACTION = "action_approve";
export const ACTION_REJECT_ACTION = "action_reject";
/** The link-only card's URL button. Deliberately NOT in
 * ACTION_APPROVAL_DECISIONS: clicking it decides nothing. */
export const ACTION_REVIEW_LINK_ACTION = "action_review_link";

/** Classify a click: an approve/reject, or an approve carrying a choice. */
export const actionApprovalClickOf = (
  actionId: string,
): { decision: ActionDecision; choice?: string } | null => {
  const choice = actionChoiceOf(actionId);
  if (choice) return { decision: "approve", choice };
  const decision = ACTION_APPROVAL_DECISIONS[actionId];
  return decision ? { decision } : null;
};

/** Slack's cap on a button's text (Block Kit button element). */
const BUTTON_TEXT_MAX = 75;

/** A button's label: escaped, and clamped to fit the button. */
const buttonText = (label: string): string => {
  const text = escapeSlackText(label);
  return text.length <= BUTTON_TEXT_MAX
    ? text
    : `${text.slice(0, BUTTON_TEXT_MAX - 1)}…`;
};

/** Click vocabulary for the inbound interactivity routes — one place, both
 * arms read it (the REACH_ACTION_DECISIONS idiom). `action_approve_always`
 * is the retired "Approve + always allow" button still on cards posted
 * before the standing question replaced it: it settles as an approve, which
 * on a standing question IS Always allow. */
export const ACTION_APPROVAL_DECISIONS: Record<string, ActionDecision> = {
  [ACTION_APPROVE_ACTION]: "approve",
  action_approve_always: "approve",
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
  /** A standing question about who the agent wants to reach: the buttons
   * read Always allow / Never instead of Approve / Reject. */
  standingChoice?: boolean;
  /** Dashboard-only decision (the approver must type a key): a link-only
   * card, no Approve/Reject buttons at all. */
  reviewUrl?: string;
  /** Done in OneCLI only (e.g. connect your Slack): a URL button. */
  link?: { url: string; label: string; note: string };
  /** A choice card: one button per option, then Cancel. */
  choices?: { value: string; label: string }[];
}): unknown[] => {
  const agent = clampHeader(escapeSlackText(input.agentName));
  const summary = clampLabel(neutralizeSummary(escapeSlackText(input.summary)));
  if (input.link) {
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${agent}* asks: ${summary}\n${escapeSlackText(input.link.note)}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            style: "primary",
            text: {
              type: "plain_text",
              text: buttonText(input.link.label),
              emoji: false,
            },
            action_id: ACTION_REVIEW_LINK_ACTION,
            url: input.link.url,
          },
        ],
      },
    ];
  }
  if (input.reviewUrl) {
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${agent}* asks: ${summary}\nThis needs a key, so it can only be approved in OneCLI. Never paste the key into Slack.`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            // A URL button: Slack opens the link; the click payload carries
            // no decision this card's action vocabulary would honor.
            type: "button",
            text: {
              type: "plain_text",
              text: "Review in OneCLI",
              emoji: false,
            },
            action_id: ACTION_REVIEW_LINK_ACTION,
            url: input.reviewUrl,
          },
        ],
      },
    ];
  }
  if (input.choices && input.choices.length > 0) {
    return [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${agent}* asks: ${summary}` },
      },
      {
        type: "actions",
        elements: [
          ...input.choices.map((c, i) => ({
            type: "button",
            ...(i === 0 && { style: "primary" }),
            text: {
              type: "plain_text",
              text: buttonText(c.label),
              emoji: false,
            },
            action_id: `${ACTION_CHOICE_PREFIX}${c.value}`,
            value: input.approvalId,
          })),
          {
            type: "button",
            text: { type: "plain_text", text: "Don't send", emoji: false },
            action_id: ACTION_REJECT_ACTION,
            value: input.approvalId,
          },
        ],
      },
    ];
  }
  // Just the ask and the buttons: a header and a how-it-works paragraph
  // read as noise around a one-line question. Reject-with-reason stays on
  // the dashboard. A standing question words the same two buttons the way
  // Contacts does.
  const [approve, reject] = input.standingChoice
    ? ["Always allow", "Never"]
    : ["Approve", "Reject"];
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${agent}* asks: ${summary}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: approve, emoji: false },
          action_id: ACTION_APPROVE_ACTION,
          value: input.approvalId,
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: reject, emoji: false },
          action_id: ACTION_REJECT_ACTION,
          value: input.approvalId,
        },
      ],
    },
  ];
};

export const settledActionCardText = (input: {
  summary: string;
  outcome: string;
  decidedByName: string;
  /** A standing question: say the answer the owner clicked (Always allow /
   * Never), the words the buttons used. */
  standing?: boolean;
}): string => {
  const summary = clampLabel(neutralizeSummary(escapeSlackText(input.summary)));
  const by = escapeSlackText(input.decidedByName);
  const [approved, rejected] = input.standing
    ? ["Always allowed", "Never"]
    : ["Approved", "Rejected"];
  switch (input.outcome) {
    case "executed":
      return `\u2705 ${approved} by ${by}: ${summary}`;
    case "rejected":
      return `\u26d4 ${rejected} by ${by}: ${summary}`;
    case "failed":
      return `\u26a0\ufe0f ${approved} by ${by}, but it failed: ${summary}`;
    case "expired":
      return `Expired: ${summary}`;
    default:
      return `${escapeSlackText(input.outcome)}: ${summary}`;
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
    standingChoice?: boolean;
    reviewUrl?: string;
    link?: { url: string; label: string; note: string };
    choices?: { value: string; label: string }[];
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
      noUnfurl: true,
    });
    return { channel: posted.channel, ts: posted.ts };
  },

  async settle(input: {
    credentialsJson: string;
    channel: string;
    ts: string;
    summary: string;
    outcome: string;
    standing?: boolean;
    decidedByName: string;
  }): Promise<void> {
    const creds = parseSlackPresenceCredentials(input.credentialsJson);
    if (!creds.botToken) return;
    const text = settledActionCardText(input);
    await updateBlocksMessage(creds.botToken, {
      channel: input.channel,
      ts: input.ts,
      text,
      blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
    });
  },
};
