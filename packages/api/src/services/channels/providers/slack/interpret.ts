import { groupThreadId, userMentionToken } from "@onecli/channels/slack";
import { z } from "zod";
import type { ChannelFileRef, SpeakerKind } from "../../types";

/**
 * Slack event → door call, in ONE place for BOTH transports: the HTTP events
 * route and the socket adapter's ingest door feed raw Slack events here, so
 * classification — and the echo guard — cannot drift between arms.
 *
 * THE ECHO GUARD lives in the drops below and is load-bearing: `message.im`
 * fires for the bot's own posts too, so without the `bot_message`/own-user
 * drops, the first answer becomes a new turn and the loop never ends
 * (mirror posts included). The ingestion doors keep their own `identityRef`
 * refusal as defense-in-depth behind this.
 *
 * APPS (PR 5a) are speakers, not noise. A message another app posts carries
 * `bot_id` AND `user` (its bot user id); the walk in `resolveSpeaker`
 * classifies it `app` and lets it through to the same doors a person takes
 * - the ingestion door then runs the same channel gate. What still drops:
 * a bot post with no `user` (a workflow/legacy integration - nothing to
 * verify or address), a bot post when our own identity is unknown (it could
 * be our own echo), and a bot post in a DM (Slack forbids bot-to-bot DMs;
 * one arriving is an unmodeled surface).
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
  // Present when ANOTHER app authored the mention (docs-verified 2026-09-07:
  // `app_mention` fires for bot-authored mentions too).
  bot_id: z.string().optional(),
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

/** The invite's mirror: the bot being REMOVED from a channel. Slack sends
 * `member_left_channel` for every leaver; only the bot's own departure is a
 * door call (teammates leaving is noise, like joins). */
const memberLeftEvent = z.object({
  type: z.literal("member_left_channel"),
  channel: z.string().min(1),
  user: z.string().min(1),
});

/** One event as it arrives — from the HTTP envelope or the socket payload. */
export const slackEventSchema = z.union([
  messageEvent,
  appMentionEvent,
  memberJoinedEvent,
  memberLeftEvent,
  // Anything else classifies as ignore below; parse it loosely so an unknown
  // event type is a non-event, never a 500.
  z.object({ type: z.string() }).passthrough(),
]);
export type SlackEvent = z.infer<typeof slackEventSchema>;

// The address codec lives in @onecli/channels/slack (one encoder/decoder
// for both runtimes); re-exported here for this file's existing callers.
export { groupThreadId };

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
      /**
       * WHERE THIS MESSAGE WAS ASKED: the DM thread's root when the person
       * typed inside a thread, else null for the top-level DM.
       *
       * A DM is ONE conversation (§3.18: the same row their web chat reads),
       * and that stays true — threads inside it are a presentation of the
       * same exchange, not separate contexts. What they DO change is the
       * address the answer belongs at: a reply typed in a thread is owed an
       * answer in that thread, not at the bottom of the DM where nobody is
       * looking.
       */
      replyThreadTs: string | null;
      /** The triggering message's own ts — where the receipt reaction sits. */
      messageTs: string;
    }
  | {
      door: "group";
      externalUserId: string;
      /** Who is speaking: a person, or an app's bot user (PR 5a). The
       * ingestion door frames and budgets apps; the gate is the same. */
      speakerKind: SpeakerKind;
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
  | {
      /** The bot was removed from a group surface - presence cleanup. */
      door: "leave";
      channel: string;
    }
  | { door: "ignore"; reason: string };

export interface InterpretContext {
  /** The presence's own Slack user id (`identityRef`) — the echo guard key. */
  botUserId: string | null;
}

/**
 * The speaker walk both the `app_mention` and `message` branches share: who
 * authored this, and may they reach a door at all. Returns the ignore reason
 * when not. Kept in one place so the app rules cannot drift between the two
 * ways a channel message arrives.
 */
const resolveSpeaker = (
  event: { user?: string; bot_id?: string },
  ctx: InterpretContext,
):
  | { externalUserId: string; speakerKind: SpeakerKind }
  | { reason: string } => {
  if (event.bot_id) {
    // A workflow/legacy integration post: no user to verify or address.
    if (!event.user) return { reason: "bot-authored:no-user" };
    // Our own identity unknown (a presence still onboarding): a bot post
    // could be our own echo, and the echo guard must not depend on luck.
    if (!ctx.botUserId) return { reason: "bot-authored:unverifiable-self" };
  }
  if (!event.user) return { reason: "no-speaker" };
  if (ctx.botUserId && event.user === ctx.botUserId) return { reason: "self" };
  return {
    externalUserId: event.user,
    speakerKind: event.bot_id ? "app" : "person",
  };
};

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

  if (event.type === "member_left_channel") {
    const left = event as z.infer<typeof memberLeftEvent>;
    // Only the BOT leaving matters - the mirror of the join rule above.
    if (!ctx.botUserId || left.user !== ctx.botUserId) {
      return { door: "ignore", reason: "someone-else-left" };
    }
    return { door: "leave", channel: left.channel };
  }

  if (event.type === "app_mention") {
    const mention = event as z.infer<typeof appMentionEvent>;
    const speaker = resolveSpeaker(mention, ctx);
    if ("reason" in speaker) return { door: "ignore", reason: speaker.reason };
    const threadRoot = mention.thread_ts ?? mention.ts;
    return {
      door: "group",
      ...speaker,
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

    // The echo guard, in drop order: any non-plain subtype (edits,
    // deletions, thread broadcasts, joins, and `bot_message` - the legacy
    // integration shape), then the speaker walk (no user, our own user id,
    // an unverifiable bot post). `file_share` is the ONE subtype that
    // passes — it is how a plain message with an attached file arrives —
    // and its echo safety rests on the speaker walk: a self-posted
    // file_share matches the presence's own user id (plus the ingestion
    // doors' identityRef defense).
    if (message.subtype && message.subtype !== "file_share") {
      return { door: "ignore", reason: `subtype:${message.subtype}` };
    }
    const speaker = resolveSpeaker(message, ctx);
    if ("reason" in speaker) return { door: "ignore", reason: speaker.reason };

    // DMs FIRST: a 1:1 IM has no `app_mention` twin, so the mention-twin drop
    // below must never see it — a user typing the bot's own @ inside its DM
    // would otherwise be silently ignored with no reply.
    if (message.channel_type === "im") {
      // Slack refuses bot-to-bot DMs (`cannot_dm_bot`), so an app can never
      // reach this door; if one somehow does, it is a surface the person
      // knock does not model - drop, never admit.
      if (speaker.speakerKind === "app") {
        return { door: "ignore", reason: "bot-authored:dm" };
      }
      return {
        door: "direct",
        externalUserId: speaker.externalUserId,
        externalThreadId: message.channel,
        text: message.text ?? "",
        files: normalizeFiles(message.files),
        replyChannel: message.channel,
        // The thread the person actually typed in, when they typed in one.
        // The CONVERSATION is still the DM's single direct row — only the
        // reply address narrows — so a threaded DM keeps one continuous
        // context and simply answers where it was asked. Before this, every
        // DM thread reply was answered at the bottom of the DM instead.
        replyThreadTs: message.thread_ts ?? null,
        messageTs: message.ts,
      };
    }

    // Slack delivers a channel message that mentions the bot as BOTH an
    // `app_mention` AND a `message.channels`/`message.groups` event, with
    // distinct event_ids the dedupe can't collapse. The `app_mention` twin is
    // authoritative (it's addressed to us); drop the `message` twin so a
    // threaded mention doesn't create a second turn — which would 409 into a
    // spurious "still working" reply on every in-thread mention.
    if (
      ctx.botUserId &&
      (message.text ?? "").includes(userMentionToken(ctx.botUserId))
    ) {
      return { door: "ignore", reason: "mention-twin" };
    }

    // Channel/group message WITHOUT a mention: only a follow-up inside a
    // thread the agent already joined counts (the dispatcher checks the link
    // exists); everything else in a channel is other people talking.
    if (message.thread_ts) {
      return {
        door: "group",
        ...speaker,
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
