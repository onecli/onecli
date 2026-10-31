import {
  conversationsHistory,
  conversationsReplies,
  deleteMessage,
  markdownToMrkdwn,
  unpackThreadAddress,
  updateBlocksMessage,
  type SlackHistoryMessage,
} from "@onecli/channels/slack";
import type { ChannelProvider, OwnReply, OwnReplyTarget } from "../../types";
import { parseSlackPresenceCredentials } from "./types";

/**
 * Slack's half of the agent's own replies (`ChannelProvider.ownReplies`).
 * The generic service has already fenced the conversation; this module
 * decides which posts in the linked thread are the agent's PLAIN replies
 * and pages the thread to find them.
 *
 * Authorship. A reply posted with the agent's avatar (`icon_url`, the
 * `chat:write.customize` path every answer takes on a deployment that can
 * serve the icon) comes back as `subtype: "bot_message"` with NO `user`
 * field; a post without the override carries the bot user id. Both carry
 * the posting app's id, so the app id is the mark (the reply judge's rule),
 * with the bot user id as the fallback for a post that has no `app_id`.
 *
 * Plain replies only. The agent's app also posts things that are not its
 * words: Block Kit cards (approvals, the live progress card, connect
 * cards), and the web mirror's copy of what a person typed on the web
 * (attributed with the globe mark). Editing a card would wipe its buttons,
 * and editing a mirror rewrites someone else's words, so neither is listed
 * nor accepted.
 */

/** `bot_message` is how an icon-customized post comes back; every other
 * subtype is bookkeeping (joins, edits, broadcasts) or a file share. */
const REPLY_SUBTYPES: ReadonlySet<string | undefined> = new Set([
  undefined,
  "bot_message",
]);

/** The web mirror's attribution prefix (`webAttribution` in the adapter):
 * an italic globe, optionally with the person's name. */
const WEB_MIRROR_PREFIX = "_(:globe_with_meridians:";

/** Thread pages read to find the newest replies: Slack returns a thread
 * oldest first from `oldest` on, so the window is walked to its end.
 * Bounded so a huge thread cannot turn one tool call into an unbounded read
 * (2,000 messages in one day's window). */
const PAGE_SIZE = 200;
const MAX_PAGES = 10;

const tsToMs = (ts: string): number => Number(ts) * 1000;
const msToTs = (ms: number): string => (ms / 1000).toFixed(6);

const isPlainReply = (m: SlackHistoryMessage, t: OwnReplyTarget): boolean =>
  (m.app_id ? m.app_id === t.externalId : m.user === t.identityRef) &&
  REPLY_SUBTYPES.has(m.subtype) &&
  (m.blocks === undefined || m.blocks.length === 0) &&
  !(m.text ?? "").startsWith(WEB_MIRROR_PREFIX);

const toReply = (m: SlackHistoryMessage): OwnReply => ({
  messageId: m.ts,
  text: m.text ?? "",
  sentAt: tsToMs(m.ts),
});

const botTokenOf = (t: OwnReplyTarget): string => {
  const { botToken } = parseSlackPresenceCredentials(t.credentialsJson);
  if (!botToken) throw new Error("Slack presence has no bot token");
  return botToken;
};

/** The thread the agent answered in: the link's address, narrowed to the
 * thread the calling turn arrived in when there is one (a threaded DM, a
 * thread in a point-of-contact room). The CHANNEL always comes from the
 * link, the adapter's own `replyTargetForTurn` rule, so a stale or odd value
 * can only point inside this conversation, never into another one. */
const addressOf = (t: OwnReplyTarget) => {
  const base = unpackThreadAddress(t.kind, t.externalThreadId);
  return t.sourceThreadId ? { ...base, threadTs: t.sourceThreadId } : base;
};

/**
 * Every message in the conversation since `oldest`, newest first. A DM is
 * a flat history (already newest first, one bounded page); a group thread
 * is walked page by page to its newest end.
 */
const messagesSince = async (
  t: OwnReplyTarget,
  oldest: string,
): Promise<SlackHistoryMessage[]> => {
  const token = botTokenOf(t);
  const { channel, threadTs } = addressOf(t);
  if (!threadTs) {
    const page = await conversationsHistory(token, {
      channel,
      oldest,
      limit: PAGE_SIZE,
    });
    return page.messages;
  }
  const messages: SlackHistoryMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await conversationsReplies(token, {
      channel,
      ts: threadTs,
      oldest,
      limit: PAGE_SIZE,
      ...(cursor && { cursor }),
    });
    messages.push(...result.messages);
    cursor = result.response_metadata?.next_cursor || undefined;
    if (!result.has_more || !cursor) break;
  }
  return messages.reverse();
};

/** Exactly one message by ts, inside this conversation, or null. A thread
 * read only ever returns that thread's messages, so an id from another
 * thread in the same channel is not found. `limit: 2` leaves room for the
 * parent, which a thread page may lead with regardless of the bounds. */
const messageAt = async (
  t: OwnReplyTarget,
  ts: string,
): Promise<SlackHistoryMessage | null> => {
  const token = botTokenOf(t);
  const { channel, threadTs } = addressOf(t);
  const bounds = { oldest: ts, latest: ts, inclusive: true, limit: 2 };
  const page = threadTs
    ? await conversationsReplies(token, { channel, ts: threadTs, ...bounds })
    : await conversationsHistory(token, { channel, ...bounds });
  return page.messages.find((m) => m.ts === ts) ?? null;
};

export const slackOwnReplies: NonNullable<ChannelProvider["ownReplies"]> = {
  async list(input) {
    const messages = await messagesSince(input, msToTs(input.since));
    return (
      messages
        .filter((m) => isPlainReply(m, input))
        .map(toReply)
        // A thread page can lead with its parent whatever `oldest` says.
        .filter((reply) => reply.sentAt >= input.since)
        .slice(0, input.limit)
    );
  },

  async find(input) {
    const message = await messageAt(input, input.messageId);
    if (!message || !isPlainReply(message, input)) return null;
    const reply = toReply(message);
    return reply.sentAt >= input.since ? reply : null;
  },

  async edit(input) {
    // The answer path's renderer: escape first (no injected <!channel>),
    // markdown to mrkdwn, and only platform-resolved ids become pings.
    // `text` alone also drops any blocks, which a plain reply has none of.
    await updateBlocksMessage(botTokenOf(input), {
      channel: addressOf(input).channel,
      ts: input.messageId,
      text: markdownToMrkdwn(input.text, { mentions: input.mentions }),
    });
  },

  async remove(input) {
    await deleteMessage(botTokenOf(input), {
      channel: addressOf(input).channel,
      ts: input.messageId,
    });
  },
};
