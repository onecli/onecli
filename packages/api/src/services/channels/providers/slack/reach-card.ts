import { escapeSlackText } from "@onecli/agent-protocol";
// Type-only: erased at compile, so the service -> registry -> provider ->
// reach-card import chain stays acyclic at runtime.
import type { ReachDecision } from "../../agent-reach-service";
import { parseSlackPresenceCredentials } from "./types";
import {
  chatUpdate,
  conversationsInfo,
  conversationsOpen,
  postBlocksMessage,
  usersInfo,
} from "./slack-api";

/**
 * The Slack rendering of the reach card - the PLATFORM-composed owner DM
 * asking "may the agent answer everyone in #channel?". The generic reach
 * service reaches it only through the provider registry's `reachCard` facet;
 * everything Slack-shaped lives here (the approval-card discipline:
 * template text is OURS, every dynamic field is escaped and clamped, and
 * the button values carry ONLY the opaque grant id).
 *
 * The card rides the presence's own bot token, so in Slack it reads as the
 * agent asking its owner - while the agent's model never sees any of this
 * (no turn is involved), and the bot-authored card can never loop back in
 * (the ingestion echo guard drops bot posts).
 */

/** Slack header blocks cap plain_text at 150 chars. */
const clampHeader = (value: string): string =>
  value.length <= 120 ? value : `${value.slice(0, 120)}…`;

const clampLabel = (value: string): string =>
  value.length <= 200 ? value : `${value.slice(0, 200)}…`;

export const REACH_APPROVE_ACTION = "reach_approve";
export const REACH_MEMBERS_ACTION = "reach_members";
export const REACH_BLOCK_ACTION = "reach_block";
/** Pre-rename alias: cards posted before the three-way settlement carry
 * this id. Mapped to `members_only` so an old card still settles. */
export const REACH_DENY_ACTION = "reach_deny";

/**
 * The card's buttons, mapped to the settlement each one means. The single
 * place the click vocabulary is decided - both inbound arms (webhook and
 * adapter relay) read it, and the legacy `reach_deny` id keeps settling
 * cards that were posted before the third button existed.
 */
export const REACH_ACTION_DECISIONS: Record<string, ReachDecision> = {
  [REACH_APPROVE_ACTION]: "approved",
  [REACH_MEMBERS_ACTION]: "members_only",
  [REACH_BLOCK_ACTION]: "blocked",
  [REACH_DENY_ACTION]: "members_only",
};

export const reachCardBlocks = (input: {
  grantId: string;
  agentName: string;
  subjectLabel: string;
}): unknown[] => {
  const agent = clampHeader(escapeSlackText(input.agentName));
  const label = clampLabel(escapeSlackText(input.subjectLabel));
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        // plain_text renders entities literally, so the header carries the
        // UNESCAPED-but-clamped name; Slack does no mrkdwn here and pings
        // are impossible in plain_text.
        text: `Channel access · ${clampHeader(input.agentName)}`,
        emoji: false,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `I was added to *${label}*. How should I handle that channel?\n` +
          `\u2022 *Allow anyone here* - I answer everyone in the channel,` +
          ` including people without OneCLI accounts.\n` +
          `\u2022 *OneCLI users only* - I answer just your linked` +
          ` teammates.\n` +
          `\u2022 *Don't allow* - I stay silent in that channel.\n` +
          `_Until you choose, I answer nobody there. You can change this` +
          ` anytime from ${agent}'s Channels page._`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Allow anyone here", emoji: false },
          action_id: REACH_APPROVE_ACTION,
          value: input.grantId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "OneCLI users only", emoji: false },
          action_id: REACH_MEMBERS_ACTION,
          value: input.grantId,
        },
        {
          type: "button",
          // Slack's own destructive styling - the only irreversible-feeling
          // choice on the card gets the visual weight to match.
          style: "danger",
          text: { type: "plain_text", text: "Don't allow", emoji: false },
          action_id: REACH_BLOCK_ACTION,
          value: input.grantId,
        },
      ],
    },
  ];
};

const settledText = (input: {
  subjectLabel: string;
  outcome: string;
  decidedByName: string;
}): string => {
  const label = clampLabel(escapeSlackText(input.subjectLabel));
  const by = escapeSlackText(input.decidedByName);
  switch (input.outcome) {
    case "approved":
      return `✅ *${label}* - answering everyone (approved by ${by}).`;
    case "denied":
      return `⛔ *${label}* - members only (decided by ${by}).`;
    case "revoked":
      return `⛔ *${label}* - back to members only (revoked by ${by}).`;
    case "left":
      return `*${label}* - I was removed from this channel, so this question is closed. If I'm re-invited, I'll ask again.`;
    default:
      return `*${label}* - ${escapeSlackText(input.outcome)} (by ${by}).`;
  }
};

/** The provider facet the generic reach service calls (`ChannelProvider.reach`). */
export const slackReach = {
  /** Group-thread addresses are minted as `<channelId>:<threadRootTs>`
   * (interpret.ts `groupThreadId`) - the space is the channel. Inverse
   * lives beside the renderer so provider-shaped reach logic has one home. */
  spaceOf: (externalThreadId: string): string =>
    externalThreadId.split(":")[0] ?? "",

  /** "#channel-name" for cards and the dashboard; null when the token
   * cannot read the channel (private, dead credential). Display only. */
  async spaceLabel(input: {
    credentialsJson: string | null;
    externalRef: string;
  }): Promise<string | null> {
    if (!input.credentialsJson) return null;
    try {
      const creds = parseSlackPresenceCredentials(input.credentialsJson);
      if (!creds.botToken) return null;
      const info = await conversationsInfo(creds.botToken, input.externalRef);
      return info.channel.name ? `#${info.channel.name}` : null;
    } catch {
      return null;
    }
  },

  /**
   * The guest lane's speaker probe: display name (untrusted - the door
   * cleans and frames it) + the same-tenant verdict. Fail-closed: any
   * lookup failure answers null and the door refuses.
   */
  async resolveGuestSpeaker(input: {
    credentialsJson: string | null;
    externalUserId: string;
    tenantExternalId: string;
  }): Promise<{ displayName: string | null; sameTenant: boolean } | null> {
    if (!input.credentialsJson) return null;
    try {
      const creds = parseSlackPresenceCredentials(input.credentialsJson);
      if (!creds.botToken) return null;
      const info = await usersInfo(creds.botToken, input.externalUserId);
      if (info.user.deleted) return null;
      return {
        displayName:
          info.user.profile?.display_name ||
          info.user.profile?.real_name ||
          info.user.name ||
          null,
        // Slack Connect participants carry a foreign team_id (and usually
        // is_stranger) - both must agree for same-tenant.
        sameTenant:
          info.user.team_id === input.tenantExternalId &&
          info.user.is_stranger !== true,
      };
    } catch {
      return null;
    }
  },

  card: {
    async post(input: {
      credentialsJson: string;
      recipientExternalUserId: string;
      grantId: string;
      agentName: string;
      subjectLabel: string;
    }): Promise<{ channel: string; ts: string }> {
      const creds = parseSlackPresenceCredentials(input.credentialsJson);
      if (!creds.botToken) throw new Error("presence has no bot token");
      const im = await conversationsOpen(
        creds.botToken,
        input.recipientExternalUserId,
      );
      const posted = await postBlocksMessage(creds.botToken, {
        channel: im.channel.id,
        // The notification-line fallback (blocks render in-app).
        text: `How should ${input.agentName} handle ${input.subjectLabel}?`,
        blocks: reachCardBlocks(input),
      });
      return { channel: posted.channel, ts: posted.ts };
    },

    async settle(input: {
      credentialsJson: string;
      channel: string;
      ts: string;
      subjectLabel: string;
      outcome: string;
      decidedByName: string;
    }): Promise<void> {
      const creds = parseSlackPresenceCredentials(input.credentialsJson);
      if (!creds.botToken) return;
      const text = settledText(input);
      await chatUpdate(creds.botToken, {
        channel: input.channel,
        ts: input.ts,
        text,
        blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
      });
    },
  },
};
