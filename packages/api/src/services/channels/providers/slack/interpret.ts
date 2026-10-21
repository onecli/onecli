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

/**
 * The bot's OWN removal, the form Slack actually delivers to a removed bot
 * (docs.slack.dev/reference/events/channel_left + group_left, checked
 * 2026-10-18): `channel_left` for a public channel, `group_left` for a
 * private one. Seen in prod (2026-10-18): a bot kicked from a private
 * channel produced no `member_left_channel` leave at all - only Slack's own
 * system DM - so `member_left_channel` alone is not a reliable leave
 * signal. These are addressed to the app's own user by construction, so no
 * user check is needed.
 */
const selfLeftEvent = z.object({
  type: z.enum(["channel_left", "group_left"]),
  channel: z.string().min(1),
});

/**
 * Slack's own SYSTEM accounts. `USLACKBOT` is Slackbot; `USLACK` is the
 * "Slack" system user that DMs notices to apps ("You have been removed from
 * #channel by @x"), in a read-only IM. Neither is a person: they must never
 * reach a door that treats the author as a speaker (the person knock would
 * otherwise ask an owner to "allow @Slack", and any reply fails with
 * `restricted_action_read_only_channel`).
 */
export const SLACK_SYSTEM_USER_IDS: ReadonlySet<string> = new Set([
  "USLACK",
  "USLACKBOT",
]);

export const isSlackSystemUser = (userId: string | undefined | null) =>
  userId != null && SLACK_SYSTEM_USER_IDS.has(userId);

/**
 * The app's own removal from the workspace (docs.slack.dev/reference/events/
 * app_uninstalled, checked 2026-09-14): sent when the app is COMPLETELY
 * uninstalled. Slack also sends `tokens_revoked`, in no guaranteed order
 * relative to this one, so both doors converge on one idempotent handler.
 */
const appUninstalledEvent = z.object({
  type: z.literal("app_uninstalled"),
});

/**
 * Token revocation (docs.slack.dev/reference/events/tokens_revoked): `tokens`
 * is keyed by token kind, each an array of USER IDS (never token strings).
 * `bot` non-empty = the bot token is dead = the presence is gone; `oauth`
 * alone names PEOPLE whose "Connect your Slack" read token died.
 */
const tokensRevokedEvent = z.object({
  type: z.literal("tokens_revoked"),
  tokens: z
    .object({
      oauth: z.array(z.string()).optional(),
      bot: z.array(z.string()).optional(),
    })
    .optional(),
});

/**
 * The native Stop (docs.slack.dev/reference/events/agent_session_stopped,
 * checked 2026-10-14): a person clicked the stop button Slack shows beside
 * an agent session in `processing`. Names the session by its conversation
 * and thread root and the person by `user`; nothing else is read.
 */
const agentSessionStoppedEvent = z.object({
  type: z.literal("agent_session_stopped"),
  channel: z.string().min(1),
  thread_ts: z.string().min(1),
  user: z.string().min(1),
});

/** One event as it arrives — from the HTTP envelope or the socket payload. */
export const slackEventSchema = z.union([
  messageEvent,
  appMentionEvent,
  memberJoinedEvent,
  memberLeftEvent,
  selfLeftEvent,
  appUninstalledEvent,
  tokensRevokedEvent,
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
      /** A TOP-LEVEL channel message with no mention. Heard only where the
       * channel is promoted (listen = "all"); dropped otherwise. */
      overheard?: boolean;
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
  | {
      /**
       * A DM from Slack's own system user (see `SLACK_SYSTEM_USER_IDS`).
       * Never a speaker: no turn, no reply, no person knock. Its only use is
       * as a HINT that the bot's channel membership may have changed (the
       * removal notice): the dispatcher re-verifies membership with the
       * provider rather than trusting or parsing the notice text.
       */
      door: "system_notice";
    }
  | {
      /** The app itself was removed from the workspace (uninstalled, or its
       * bot token revoked) - the presence is dead until re-attached. */
      door: "removed";
      reason: "app_uninstalled" | "tokens_revoked";
    }
  | {
      /** Only PEOPLE's tokens died (a member revoked their own grant, or was
       * deactivated): their personal read access through this app goes. */
      door: "user-tokens-revoked";
      externalUserIds: string[];
    }
  | {
      /** A person clicked the native Stop on the agent session rooted at
       * `threadTs` in `channel` (a DM or a channel thread alike). */
      door: "stop";
      externalUserId: string;
      channel: string;
      threadTs: string;
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
  // Slack's own system accounts are never speakers (no person to knock
  // for, nobody to answer). The DM branch turns them into a membership
  // hint before reaching here; anywhere else they are dropped.
  if (isSlackSystemUser(event.user)) return { reason: "slack-system-user" };
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

  if (event.type === "channel_left" || event.type === "group_left") {
    const left = selfLeftEvent.safeParse(event);
    if (!left.success) return { door: "ignore", reason: "unparseable" };
    return { door: "leave", channel: left.data.channel };
  }

  if (event.type === "app_uninstalled") {
    return { door: "removed", reason: "app_uninstalled" };
  }

  if (event.type === "tokens_revoked") {
    const revoked = event as z.infer<typeof tokensRevokedEvent>;
    // Only the BOT token dying kills the presence. User-token revocations
    // (the `oauth` list) name people whose "Connect your Slack" read
    // grant died: their personal token rows go, the presence lives on.
    if ((revoked.tokens?.bot?.length ?? 0) > 0) {
      return { door: "removed", reason: "tokens_revoked" };
    }
    const users = (revoked.tokens?.oauth ?? []).filter(Boolean);
    if (users.length > 0) {
      return { door: "user-tokens-revoked", externalUserIds: users };
    }
    return { door: "ignore", reason: "tokens_revoked:empty" };
  }

  if (event.type === "agent_session_stopped") {
    // Parsed strictly here rather than through the union above: its loose
    // fallback also matches this type name, and half a stop (no thread, no
    // clicker) names no session to stop.
    const stopped = agentSessionStoppedEvent.safeParse(event);
    if (!stopped.success) return { door: "ignore", reason: "stop:malformed" };
    // Only a person clicks Stop; one naming our own bot user is not a click.
    if (ctx.botUserId && stopped.data.user === ctx.botUserId) {
      return { door: "ignore", reason: "stop:self" };
    }
    return {
      door: "stop",
      externalUserId: stopped.data.user,
      channel: stopped.data.channel,
      threadTs: stopped.data.thread_ts,
    };
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
    // Slack's system DM (the removal notice and its kin): a membership
    // hint, never a speaker. Checked BEFORE the speaker walk so the person
    // knock can never see it.
    if (message.channel_type === "im" && isSlackSystemUser(message.user)) {
      return { door: "system_notice" };
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

    // Channel/group message WITHOUT a mention: a follow-up inside a thread
    // the agent already joined counts (the dispatcher checks the link
    // exists). A TOP-LEVEL message is "overheard": it counts only where a
    // person promoted the agent to hear every message (listen = "all"),
    // which the dispatcher checks against the channel's reach row.
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
    return {
      door: "group",
      ...speaker,
      // The message's own thread address: an @mention-style reply would go
      // under it. A point-of-contact answer uses the channel's room instead
      // (the dispatcher decides where it lands).
      externalThreadId: groupThreadId(message.channel, message.ts),
      text: message.text ?? "",
      files: normalizeFiles(message.files),
      replyChannel: message.channel,
      replyThreadTs: message.ts,
      messageTs: message.ts,
      isMention: false,
      overheard: true,
    };
  }

  return { door: "ignore", reason: `event:${event.type}` };
};
