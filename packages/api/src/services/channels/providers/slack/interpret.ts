import { z } from "zod";
import type { ChannelFileRef } from "../../types";

/**
 * Slack event → door call, in ONE place for BOTH transports: the HTTP events
 * route and the socket adapter's ingest door feed raw Slack events here, so
 * classification — and the echo guard — cannot drift between arms.
 *
 * THE ECHO GUARD lives in the drops below and is load-bearing: `message.im`
 * fires for the bot's own posts too, so without the `bot_id`/`bot_message`/
 * own-user drops, the first answer becomes a new turn and the loop never
 * ends (mirror posts included). The ingestion doors keep their own
 * `identityRef` refusal as defense-in-depth behind this.
 */

/**
 * One element of a message's `files[]`, parsed loosely: Slack's file object
 * has dozens of fields and only these matter to the download path. A Slack
 * Connect share arrives as a stub (`mode: "file_access"`,
 * `file_access: "check_file_info"`) whose real metadata needs a `files.info`
 * follow-up — the fetch hook handles that arm.
 */
const slackFileRef = z
  .object({
    id: z.string().min(1),
    name: z.string().nullish(),
    mimetype: z.string().nullish(),
    size: z.number().int().nullish(),
    url_private: z.string().nullish(),
    mode: z.string().nullish(),
    file_access: z.string().nullish(),
  })
  .loose();

const normalizeFiles = (
  files: z.infer<typeof slackFileRef>[] | undefined,
): ChannelFileRef[] =>
  (files ?? []).map((file) => ({
    id: file.id,
    name: file.name ?? null,
    mimeType: file.mimetype ?? null,
    size: file.size ?? null,
    url: file.url_private ?? null,
    needsInfo: file.file_access === "check_file_info",
  }));

const messageEvent = z.object({
  type: z.literal("message"),
  channel: z.string().min(1),
  channel_type: z.string().optional(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  subtype: z.string().optional(),
  text: z.string().optional(),
  files: z.array(slackFileRef).optional(),
  ts: z.string().min(1),
  thread_ts: z.string().optional(),
});

const appMentionEvent = z.object({
  type: z.literal("app_mention"),
  channel: z.string().min(1),
  user: z.string().optional(),
  text: z.string().optional(),
  // Slack mirrors the mentioning message's fields, files included — parsed
  // defensively (a mention with a file must not lose it; the message twin
  // that also carries it is dropped as the twin).
  files: z.array(slackFileRef).optional(),
  ts: z.string().min(1),
  thread_ts: z.string().optional(),
});

const memberJoinedEvent = z.object({
  type: z.literal("member_joined_channel"),
  channel: z.string().min(1),
  user: z.string().min(1),
  inviter: z.string().optional(),
});

/** One event as it arrives — from the HTTP envelope or the socket payload. */
export const slackEventSchema = z.union([
  messageEvent,
  appMentionEvent,
  memberJoinedEvent,
  // Anything else classifies as ignore below; parse it loosely so an unknown
  // event type is a non-event, never a 500.
  z.object({ type: z.string() }).passthrough(),
]);
export type SlackEvent = z.infer<typeof slackEventSchema>;

/** The group-thread address (§step-6 decision 2): the THREAD, not the
 * channel — parallel threads get parallel contexts. A top-level trigger
 * starts a thread rooted at itself. */
export const groupThreadId = (channel: string, threadRootTs: string): string =>
  `${channel}:${threadRootTs}`;

export type SlackDoorCall =
  | {
      door: "direct";
      externalUserId: string;
      externalThreadId: string;
      text: string;
      /** Files shared with the message — metadata refs; bytes are fetched
       * control-plane-side AFTER the speaker authorizes. */
      files: ChannelFileRef[];
      /** Where the answer goes (Slack channel id — the IM). */
      replyChannel: string;
      /** Slack threads DM replies too when asked; DMs answer top-level. */
      replyThreadTs: null;
      /** The triggering message's own ts — where the receipt reaction sits. */
      messageTs: string;
    }
  | {
      door: "group";
      externalUserId: string;
      externalThreadId: string;
      text: string;
      files: ChannelFileRef[];
      replyChannel: string;
      replyThreadTs: string;
      /** The triggering message's own ts — where the receipt reaction sits. */
      messageTs: string;
      /** True when the event was an `app_mention` — addressed to the bot.
       * Plain thread follow-ups (no mention) are false; the dispatchers use
       * this to fence unjoined/unbound thread chatter. */
      isMention: boolean;
    }
  | {
      door: "invite";
      inviterExternalUserId: string | null;
      channel: string;
    }
  | { door: "ignore"; reason: string };

export interface InterpretContext {
  /** The presence's own Slack user id (`identityRef`) — the echo guard key. */
  botUserId: string | null;
}

/**
 * Classify one event. Pure — no IO, fully unit-testable, and the mutation
 * target for the echo-guard tests.
 */
export const interpretSlackEvent = (
  raw: unknown,
  ctx: InterpretContext,
): SlackDoorCall => {
  const parsed = slackEventSchema.safeParse(raw);
  if (!parsed.success) return { door: "ignore", reason: "unparseable" };
  const event = parsed.data;

  if (event.type === "member_joined_channel") {
    const joined = event as z.infer<typeof memberJoinedEvent>;
    // Only the BOT joining is an invite; teammates joining channels the bot
    // sits in is noise.
    if (!ctx.botUserId || joined.user !== ctx.botUserId) {
      return { door: "ignore", reason: "someone-else-joined" };
    }
    return {
      door: "invite",
      inviterExternalUserId: joined.inviter ?? null,
      channel: joined.channel,
    };
  }

  if (event.type === "app_mention") {
    const mention = event as z.infer<typeof appMentionEvent>;
    if (!mention.user) return { door: "ignore", reason: "no-speaker" };
    if (ctx.botUserId && mention.user === ctx.botUserId) {
      return { door: "ignore", reason: "self" };
    }
    const threadRoot = mention.thread_ts ?? mention.ts;
    return {
      door: "group",
      externalUserId: mention.user,
      externalThreadId: groupThreadId(mention.channel, threadRoot),
      text: mention.text ?? "",
      files: normalizeFiles(mention.files),
      replyChannel: mention.channel,
      replyThreadTs: threadRoot,
      messageTs: mention.ts,
      isMention: true,
    };
  }

  if (event.type === "message") {
    const message = event as z.infer<typeof messageEvent>;

    // The echo guard, in drop order: anything bot-authored, any non-plain
    // subtype (edits, deletions, thread broadcasts, joins…), then anything
    // from the presence's own user id. `file_share` is the ONE subtype that
    // passes — it is how a plain message with an attached file arrives — and
    // its echo safety rests on the other two arms: a bot-posted file_share
    // carries `bot_id` (dropped above this line), a self-posted one matches
    // the presence's own user id (dropped below, plus the ingestion doors'
    // identityRef defense).
    if (message.bot_id) return { door: "ignore", reason: "bot-authored" };
    if (message.subtype && message.subtype !== "file_share") {
      return { door: "ignore", reason: `subtype:${message.subtype}` };
    }
    if (!message.user) return { door: "ignore", reason: "no-speaker" };
    if (ctx.botUserId && message.user === ctx.botUserId) {
      return { door: "ignore", reason: "self" };
    }

    // DMs FIRST: a 1:1 IM has no `app_mention` twin, so the mention-twin drop
    // below must never see it — a user typing the bot's own @ inside its DM
    // would otherwise be silently ignored with no reply.
    if (message.channel_type === "im") {
      return {
        door: "direct",
        externalUserId: message.user,
        externalThreadId: message.channel,
        text: message.text ?? "",
        files: normalizeFiles(message.files),
        replyChannel: message.channel,
        replyThreadTs: null,
        messageTs: message.ts,
      };
    }

    // Slack delivers a channel message that mentions the bot as BOTH an
    // `app_mention` AND a `message.channels`/`message.groups` event, with
    // distinct event_ids the dedupe can't collapse. The `app_mention` twin is
    // authoritative (it's addressed to us); drop the `message` twin so a
    // threaded mention doesn't create a second turn — which would 409 into a
    // spurious "still working" reply on every in-thread mention.
    if (ctx.botUserId && (message.text ?? "").includes(`<@${ctx.botUserId}>`)) {
      return { door: "ignore", reason: "mention-twin" };
    }

    // Channel/group message WITHOUT a mention: only a follow-up inside a
    // thread the agent already joined counts (the dispatcher checks the link
    // exists); everything else in a channel is other people talking.
    if (message.thread_ts) {
      return {
        door: "group",
        externalUserId: message.user,
        externalThreadId: groupThreadId(message.channel, message.thread_ts),
        text: message.text ?? "",
        files: normalizeFiles(message.files),
        replyChannel: message.channel,
        replyThreadTs: message.thread_ts,
        messageTs: message.ts,
        isMention: false,
      };
    }
    return { door: "ignore", reason: "channel-chatter" };
  }

  return { door: "ignore", reason: `event:${event.type}` };
};
