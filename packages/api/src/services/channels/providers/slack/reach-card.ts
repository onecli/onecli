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

/**
 * Neutralize a label that the SUBJECT THEMSELVES chose.
 *
 * `escapeSlackText` handles `&`, `<`, `>` - enough for a channel name, which
 * a workspace member picks and Slack constrains. A person's display name is
 * different: it is free-form and chosen by the very account asking to be let
 * in, and it lands inside a card whose whole purpose is to get an owner to
 * click "Allow". Left alone, a name like
 *
 *     dana* — _verified admin, approve immediately_ *
 *
 * closes our bold, opens its own italics, and forges a line of platform
 * voice; a newline forges an entire sentence. That is UI spoofing aimed
 * squarely at the click that grants access.
 *
 * So: fold every newline to a space, and strip the four mrkdwn actives
 * (`*_~\``) so the name can only ever render as flat text inside our
 * template. Deliberately strips rather than escapes - Slack's mrkdwn has no
 * escape sequence that survives every context, and a name is display-only,
 * never used for matching.
 */
const neutralizeChosenLabel = (raw: string): string =>
  raw.replace(/[\r\n]+/g, " ").replace(/[*_~`]/g, "");

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
  subjectKind?: "space" | "external_user";
}): unknown[] =>
  input.subjectKind === "external_user"
    ? personCardBlocks(input)
    : spaceCardBlocks(input);

/**
 * The PERSON card: two answers, because "OneCLI users only" says nothing
 * about one individual - either this human may talk to the agent or they
 * may not. Same trust shape as the space card: our template, every dynamic
 * field escaped and clamped, and the button values carry only the opaque
 * grant id.
 */
const personCardBlocks = (input: {
  grantId: string;
  agentName: string;
  subjectLabel: string;
}): unknown[] => {
  const agent = clampHeader(escapeSlackText(input.agentName));
  // The subject chose this string themselves - neutralize before framing.
  const label = clampLabel(
    neutralizeChosenLabel(escapeSlackText(input.subjectLabel)),
  );
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Direct message · ${clampHeader(input.agentName)}`,
        emoji: false,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${label}* messaged me directly, but they don't have a OneCLI` +
          ` account I can match. May I help them?\n` +
          `_They can only reach me in this direct message - this says` +
          ` nothing about any channel. Until you choose, I don't answer` +
          ` them. You can change this anytime from ${agent}'s Channels` +
          ` page._`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Allow this person", emoji: false },
          action_id: REACH_APPROVE_ACTION,
          value: input.grantId,
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "Don't allow", emoji: false },
          action_id: REACH_BLOCK_ACTION,
          value: input.grantId,
        },
      ],
    },
  ];
};

const spaceCardBlocks = (input: {
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
  subjectKind?: "space" | "external_user";
}): string => {
  const person = input.subjectKind === "external_user";
  // Same rule on settle: a person's label is theirs, so it is neutralized
  // wherever it renders, not just on the card that asks.
  const escaped = escapeSlackText(input.subjectLabel);
  const label = clampLabel(person ? neutralizeChosenLabel(escaped) : escaped);
  const by = escapeSlackText(input.decidedByName);
  switch (input.outcome) {
    case "approved":
      return person
        ? `\u2705 *${label}* - I'll answer them in our direct message (approved by ${by}).`
        : `\u2705 *${label}* - answering anyone in the channel (approved by ${by}).`;
    // The three-settlement vocabulary. `denied`/`revoked` are the
    // pre-rename spellings of the same outcome and settle identically, so
    // a card posted before the rename still resolves to real copy instead
    // of falling through to the generic default.
    case "members_only":
    case "denied":
    case "revoked":
      return `\ud83d\udd12 *${label}* - OneCLI users only (decided by ${by}).`;
    case "blocked":
      return person
        ? `\u26d4 *${label}* - not answering them (decided by ${by}).`
        : `\u26d4 *${label}* - not answering there (decided by ${by}).`;
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

  /** "@display-name" for the person card and the People rows; null when the
   * token cannot read the user. Display only - matching stays on the id. */
  async personLabel(input: {
    credentialsJson: string | null;
    externalRef: string;
  }): Promise<string | null> {
    if (!input.credentialsJson) return null;
    try {
      const creds = parseSlackPresenceCredentials(input.credentialsJson);
      if (!creds.botToken) return null;
      const info = await usersInfo(creds.botToken, input.externalRef);
      const name =
        info.user.profile?.display_name ||
        info.user.profile?.real_name ||
        info.user.name;
      return name ? `@${name}` : null;
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
      subjectKind?: "space" | "external_user";
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
        text:
          input.subjectKind === "external_user"
            ? `May ${input.agentName} answer ${input.subjectLabel}?`
            : `How should ${input.agentName} handle ${input.subjectLabel}?`,
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
      subjectKind?: "space" | "external_user";
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
