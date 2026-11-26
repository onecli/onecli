import { db } from "@onecli/db";
import { ChannelProviderApiError, mentionNamesOf } from "@onecli/channels";
import { getCrypto } from "../../providers";
import { ServiceError } from "../errors";
import { channelProvider, isChannelProviderId } from "./registry";
import type { ChannelProvider, OwnReply, OwnReplyTarget } from "./types";
import { noteOutboundFailure } from "./agent-channel-service";
import { decodeInboundText } from "./channel-ingestion-service";
import { resolveMentionNames } from "./mention-resolution-service";
import {
  canTalkWith,
  resolveSendRecipient,
  type SendRecipient,
} from "./send-message-service";
import { cleanLabel } from "../../lib/format";
import {
  getConversationSender,
  type ActAsYouOutcome,
} from "../../providers/hooks/conversation-reader";

/**
 * The agent fixes ITS OWN replies in the conversation it is in right now
 * (`list_my_replies`, `edit_my_reply`, `delete_my_reply`): a wrong answer, a
 * typo, something the person asks it to take back.
 *
 * The fence, layered:
 *  1. Conversation: only the thread linked to the calling turn's verified
 *     conversation. The caller resolves it by provenance, never from a
 *     model-supplied id, and a forged or missing context resolves to none.
 *  2. Authorship: the provider lists and accepts only the agent's own plain
 *     replies in that thread (`ChannelProvider.ownReplies`), and every id is
 *     re-checked against that thread before anything is changed.
 *  3. Time: only replies from the last 24 hours, the act-as-you window.
 *  4. The provider itself: a bot token can only change its own posts.
 *
 * No approval inside the same conversation: the person is right there to see
 * the change and object.
 *
 * With `conversation` (a #channel or a person, as send_message names them),
 * the agent reaches its own messages ELSEWHERE, e.g. a post a schedule made.
 * Contacts' "Can talk with" must allow the agent there, the same authorship
 * and 24-hour rules hold, and WHO may ask depends on the message
 * (`agentAccessOf`, `changeAsYou`): a message sent as a person only by that
 * person; the agent's own DM posts only by the person the DM is with; its
 * channel posts by anyone asking from that channel or a workspace owner;
 * and a schedule always reaches the posts it sent itself. Never a card,
 * never someone else's words, and no approval card for the agent's own
 * posts.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;
const LIST_LIMIT = 20;
/** Under the tool-result cap with room to spare: 20 replies at most. */
const MAX_LISTED_CHARS = 2_000;

const NO_CONVERSATION =
  "This only works inside a chat or channel conversation you're in, and there is none here. Nothing was changed.";

/** Live presences answer; `needs_attention` only pauses approvals and
 * proactive sends, and its credential still works. */
const LIVE_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "needs_attention",
]);

interface OwnReplyView {
  /** Pass back to edit_my_reply / delete_my_reply. */
  messageId: string;
  text: string;
  /** ISO time the reply was sent. */
  sentAt: string;
  /** "agent" = posted by the agent's app; "you" = sent as the person (a
   * delete of one asks them first). */
  sentAs: "agent" | "you";
}

interface Resolved {
  presenceId: string;
  facet: NonNullable<ChannelProvider["ownReplies"]>;
  platform: string;
  target: OwnReplyTarget;
  decode: (text: string) => Promise<string>;
}

/** The linked conversation of the calling turn, or a clear refusal. The
 * turn narrows WHERE in that conversation the agent answered (a DM thread,
 * or a thread of a point-of-contact room): its `sourceThreadId`, read from
 * the verified turn row, never from the model. */
const resolve = async (
  agentId: string,
  conversationId: string | null,
  turnId: string | null,
): Promise<Resolved> => {
  if (!conversationId) {
    throw new ServiceError("UNPROCESSABLE", NO_CONVERSATION);
  }
  const [link, turn] = await Promise.all([
    // Fenced to the calling agent in the query itself: another agent's
    // conversation reads as no link at all.
    db.channelThreadLink.findFirst({
      where: { conversationId, agentChannel: { agentId } },
      select: {
        kind: true,
        externalThreadId: true,
        agentChannel: {
          select: {
            id: true,
            provider: true,
            status: true,
            externalId: true,
            identityRef: true,
            credentials: true,
            integrationId: true,
            integration: { select: { externalId: true } },
            agent: { select: { name: true } },
          },
        },
      },
    }),
    turnId
      ? db.turn.findFirst({
          where: { id: turnId, conversationId },
          select: { sourceThreadId: true },
        })
      : null,
  ]);
  const presence = link?.agentChannel;
  if (!presence || !isChannelProviderId(presence.provider)) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "This conversation isn't in a chat app like Slack, so there are no posted replies of yours to change here. Nothing was changed.",
    );
  }
  const provider = channelProvider(presence.provider);
  const facet = provider.ownReplies;
  if (!facet) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `Your replies in ${provider.displayName} can't be changed after they are posted. Nothing was changed.`,
    );
  }
  if (
    !LIVE_STATUSES.has(presence.status) ||
    !presence.credentials ||
    !presence.identityRef
  ) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `Your ${provider.displayName} app isn't connected right now, so your replies can't be changed. Don't retry.`,
    );
  }
  const credentialsJson = await getCrypto().decrypt(presence.credentials);
  return {
    presenceId: presence.id,
    facet,
    platform: provider.displayName,
    target: {
      credentialsJson,
      externalId: presence.externalId,
      identityRef: presence.identityRef,
      externalThreadId: link.externalThreadId,
      kind: link.kind === "direct" ? "direct" : "group",
      sourceThreadId: turn?.sourceThreadId ?? null,
    },
    decode: (text) => decodeInboundText(presence, text),
  };
};

/**
 * Run a provider call, translating its refusal into words the model can act
 * on: a dead credential flips the presence (the bell alert) and says so;
 * any other refusal names the provider's own code and says not to retry
 * blindly. A non-provider error propagates (the tool door's generic arm).
 */
const call = async <T>(
  r: Pick<Resolved, "presenceId" | "platform">,
  op: () => Promise<T>,
): Promise<T> => {
  try {
    return await op();
  } catch (err) {
    if (await noteOutboundFailure(r.presenceId, err)) {
      throw new ServiceError(
        "UNPROCESSABLE",
        `Your ${r.platform} app was removed from the workspace, so this no longer works. It needs to be re-attached from your Channels page. Don't retry.`,
      );
    }
    if (err instanceof ChannelProviderApiError) {
      throw new ServiceError(
        "UNPROCESSABLE",
        `${r.platform} refused the change (${err.code}). Nothing was changed. Don't retry the same call.`,
      );
    }
    throw err;
  }
};

/** Who is acting: the verified reader of a private turn (a DM, the web
 * chat, or a schedule's run for its creator) and whoever typed the turn. */
interface Caller {
  agentId: string;
  conversationId: string | null;
  turnId: string | null;
  readerUserId?: string | null;
  askerUserId?: string | null;
  now?: number;
  /** A #channel or person elsewhere (see the module note). */
  conversation?: string;
}

/** Which of the agent's own posts in a named conversation this caller may
 * list and change: all of them, only the ones this schedule sent, or none
 * (and why). */
type AgentAccess =
  | { kind: "all" }
  | { kind: "schedule"; conversationId: string }
  | { kind: "none"; reason: "contacts" | "asker" };

/** The conversation the agent names (not the one it is in), resolved the
 * way send_message resolves `to`, with this caller's reach over the
 * agent's own posts there. */
interface Elsewhere {
  r: Resolved;
  label: string;
  /** The recipient's provider id (channel or person): the "as you" key. */
  recipientRef: string;
  access: AgentAccess;
  /** The model's refusal when `access` is none. */
  refusal: string | null;
}

/** Every refusal from here ends the attempt: a different spelling of the
 * same name resolves the same way, so retrying cannot help. */
const STOP =
  "Don't retry with another spelling; tell the person in one short line.";

/**
 * Who may reach the agent's own posts in a named conversation, from verified
 * rows only. Contacts must allow the agent there, then:
 *  - a channel: anyone asking from inside that channel, or a workspace owner
 *    asking privately (their DM or web chat with the agent, or a run of
 *    their own schedule);
 *  - a person: only that person, asking in their own chat with the agent;
 *  - a schedule's own run (a fire, not someone typing into its
 *    conversation), whoever made the schedule: the posts it sent itself.
 */
const agentAccessOf = async (input: {
  agentId: string;
  presence: { id: string; integrationId: string };
  recipient: SendRecipient;
  spaceOf: ((externalThreadId: string) => string) | undefined;
  caller: Caller;
}): Promise<AgentAccess> => {
  const { agentId, presence, recipient, caller } = input;
  const reader = caller.readerUserId ?? null;
  const [allowed, origin, link, owner, readerLink] = await Promise.all([
    canTalkWith(agentId, recipient),
    caller.conversationId
      ? db.conversation.findFirst({
          where: { id: caller.conversationId, agentId },
          select: { id: true, source: true },
        })
      : null,
    caller.conversationId && recipient.kind === "channel"
      ? db.channelThreadLink.findFirst({
          where: {
            conversationId: caller.conversationId,
            agentChannelId: presence.id,
            kind: "group",
          },
          select: { externalThreadId: true },
        })
      : null,
    reader && recipient.kind === "channel"
      ? db.workspaceAccess.findFirst({
          where: {
            userId: reader,
            role: "owner",
            workspace: { agents: { some: { id: agentId } } },
          },
          select: { id: true },
        })
      : null,
    reader && recipient.kind === "person"
      ? db.channelUserLink.findUnique({
          where: {
            integrationId_userId: {
              integrationId: presence.integrationId,
              userId: reader,
            },
          },
          select: { externalUserId: true },
        })
      : null,
  ]);
  if (!allowed) return { kind: "none", reason: "contacts" };
  const askedThere =
    link !== null && input.spaceOf?.(link.externalThreadId) === recipient.ref;
  const mayAsk =
    recipient.kind === "channel"
      ? owner !== null || askedThere
      : readerLink?.externalUserId === recipient.ref;
  if (mayAsk) return { kind: "all" };
  const scheduleFire =
    origin?.source === "cron" && caller.turnId !== null && !caller.askerUserId;
  return scheduleFire
    ? { kind: "schedule", conversationId: origin.id }
    : { kind: "none", reason: "asker" };
};

/**
 * The conversation the agent names, resolved with send_message's own lookup
 * (a name that worked for sending works here), with this caller's reach
 * over the agent's own posts there, and where they live: a channel by its
 * id, a person by the agent's DM with them (opened through the provider
 * when no link is on record, as send_message opened it; only for a caller
 * who may reach it).
 */
const resolveElsewhere = async (
  input: Caller & { conversation: string },
): Promise<Elsewhere> => {
  const recipient = await resolveSendRecipient(
    input.agentId,
    input.conversation,
    input.conversationId,
  ).catch((err: unknown) => {
    if (err instanceof ServiceError) {
      throw new ServiceError(
        "UNPROCESSABLE",
        `${err.message.replace(/ Use find_recipient.*$/, "")} Nothing was changed. ${STOP}`,
      );
    }
    throw err;
  });
  const presence = await db.agentChannel.findFirst({
    where: { agentId: input.agentId, status: { in: [...LIVE_STATUSES] } },
    select: {
      id: true,
      provider: true,
      externalId: true,
      identityRef: true,
      credentials: true,
      integrationId: true,
      integration: { select: { externalId: true } },
      agent: { select: { name: true } },
    },
  });
  if (
    !presence ||
    !isChannelProviderId(presence.provider) ||
    !presence.credentials ||
    !presence.identityRef
  ) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "Your chat app isn't connected right now, so your messages can't be changed. Don't retry.",
    );
  }
  const provider = channelProvider(presence.provider);
  const facet = provider.ownReplies;
  if (!facet) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `Your messages in ${provider.displayName} can't be changed after they are posted. Nothing was changed.`,
    );
  }
  const access = await agentAccessOf({
    agentId: input.agentId,
    presence,
    recipient,
    spaceOf: provider.reach?.spaceOf,
    caller: input,
  });
  const credentialsJson = await getCrypto().decrypt(presence.credentials);
  const where = { presenceId: presence.id, platform: provider.displayName };
  let channel = recipient.ref;
  if (recipient.kind === "person" && access.kind !== "none") {
    const dm = await db.channelThreadLink.findFirst({
      where: {
        agentChannelId: presence.id,
        kind: "direct",
        externalUserId: recipient.ref,
      },
      select: { externalThreadId: true },
    });
    channel =
      dm?.externalThreadId ??
      (await call(where, () =>
        facet.directWith({ credentialsJson, personRef: recipient.ref }),
      ));
  }
  const agentName = cleanLabel(presence.agent.name, 80) || "This agent";
  const refusal =
    access.kind !== "none"
      ? null
      : access.reason === "contacts"
        ? `${agentName} isn't allowed to talk in ${recipient.label}. Change it in Contacts. Nothing was changed. ${STOP}`
        : recipient.kind === "channel"
          ? `Only someone asking in ${recipient.label} itself, or a workspace owner, can change your messages there. Nothing was changed. ${STOP}`
          : `Only ${recipient.label}, in their own chat with you, can change your messages to them. Nothing was changed. ${STOP}`;
  return {
    label: recipient.label,
    recipientRef: recipient.ref,
    access,
    refusal,
    r: {
      ...where,
      facet,
      target: {
        credentialsJson,
        externalId: presence.externalId,
        identityRef: presence.identityRef,
        externalThreadId: channel,
        kind: recipient.kind === "person" ? "direct" : "group",
        sourceThreadId: null,
      },
      decode: (text) => decodeInboundText(presence, text),
    },
  };
};

/**
 * The send ledger's posts in that conversation from `since` on, by their
 * own ids: at its top level or inside any thread there (the provider's
 * reply addresses: the conversation itself, or `<conversation>:<thread>`).
 * Narrowed to what one conversation asked for, or to one message.
 */
const ledgerPosts = async (
  e: Elsewhere,
  since: number,
  only: { originConversationId?: string; messageRef?: string } = {},
): Promise<string[]> => {
  const conversation = e.r.target.externalThreadId;
  const rows = await db.channelSentMessage.findMany({
    where: {
      agentChannelId: e.r.presenceId,
      OR: [
        { externalThreadId: conversation },
        { externalThreadId: { startsWith: `${conversation}:` } },
      ],
      messageRef: only.messageRef ?? { not: null },
      createdAt: { gte: new Date(since) },
      ...(only.originConversationId && {
        originConversationId: only.originConversationId,
      }),
    },
    orderBy: { createdAt: "desc" },
    take: LIST_LIMIT,
    select: { messageRef: true },
  });
  return rows.flatMap((row) => (row.messageRef ? [row.messageRef] : []));
};

/** The agent's own posts there this caller may see: the conversation's top
 * level plus the ledger's thread posts (all access), or only the posts this
 * schedule sent. Each is read back through the provider, so authorship and
 * the card rule hold. */
const listAgentElsewhere = async (
  e: Elsewhere,
  since: number,
): Promise<OwnReply[]> => {
  const { r, access } = e;
  if (access.kind === "none") return [];
  const top =
    access.kind === "all"
      ? await call(r, () =>
          r.facet.list({ ...r.target, since, limit: LIST_LIMIT }),
        )
      : [];
  const seen = new Set(top.map((m) => m.messageId));
  const extra: OwnReply[] = [];
  const refs = await ledgerPosts(
    e,
    since,
    access.kind === "schedule"
      ? { originConversationId: access.conversationId }
      : {},
  );
  for (const messageId of refs) {
    if (seen.has(messageId)) continue;
    const found = await call(r, () =>
      r.facet.findAnywhere({ ...r.target, messageId, since }),
    );
    if (found) {
      seen.add(found.messageId);
      extra.push(found);
    }
  }
  return [...top, ...extra];
};

/** The messages sent AS the reader there (licensed seam). Their words are
 * theirs: listed only to them, in a private turn. */
const listAsYou = async (input: Caller, e: Elsewhere) => {
  const sender = getConversationSender();
  if (!sender || !input.readerUserId) return [];
  return sender.listOwn({
    agentId: input.agentId,
    readerUserId: input.readerUserId,
    recipientRef: e.recipientRef,
  });
};

const clip = (text: string) =>
  text.length > MAX_LISTED_CHARS
    ? `${text.slice(0, MAX_LISTED_CHARS)}… [truncated]`
    : text;

/** The agent's own messages, newest first: its app's posts AND (with
 * conversation, in a private turn) what it sent as the person there, each
 * marked. */
export const listOwnReplies = async (
  input: Caller,
): Promise<OwnReplyView[]> => {
  const since = (input.now ?? Date.now()) - WINDOW_MS;
  if (!input.conversation) {
    const r = await resolve(input.agentId, input.conversationId, input.turnId);
    const replies = await call(r, () =>
      r.facet.list({ ...r.target, since, limit: LIST_LIMIT }),
    );
    return Promise.all(
      replies.map(async (reply) => ({
        messageId: reply.messageId,
        text: clip(await r.decode(reply.text)),
        sentAt: new Date(reply.sentAt).toISOString(),
        sentAs: "agent" as const,
      })),
    );
  }
  const e = await resolveElsewhere({
    ...input,
    conversation: input.conversation,
  });
  const [agent, asYou] = await Promise.all([
    listAgentElsewhere(e, since),
    listAsYou(input, e),
  ]);
  if (e.refusal && asYou.length === 0) {
    throw new ServiceError("UNPROCESSABLE", e.refusal);
  }
  const views: OwnReplyView[] = [
    ...(await Promise.all(
      agent.map(async (m) => ({
        messageId: m.messageId,
        text: clip(await e.r.decode(m.text)),
        sentAt: new Date(m.sentAt).toISOString(),
        sentAs: "agent" as const,
      })),
    )),
    ...asYou.map((m) => ({
      messageId: m.messageId,
      text: clip(m.text),
      sentAt: new Date(m.sentAt).toISOString(),
      sentAs: "you" as const,
    })),
  ];
  return views
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
    .slice(0, LIST_LIMIT);
};

/** What an edit/delete did: through the agent's app (and where, for the
 * audit), or as the person (whose outcome, e.g. a held delete, the tool
 * door returns verbatim). */
export type OwnChange =
  | { via: "agent"; presenceId: string; conversationRef: string | null }
  | { via: "you"; outcome: ActAsYouOutcome };

type Change = { op: "edit"; text: string } | { op: "delete" };

/**
 * A message the agent sent AS the person goes through the act-as-you seam
 * (their grant, the send_as_me record, their write mode; a delete always
 * asks them). Only that person may ask: the reader of their own private
 * chat, or whoever typed the turn in a shared place, where the seam holds
 * every change for their own DM card. Null = not a message sent as the
 * asker there.
 */
const changeAsYou = async (
  input: Caller & { messageId: string },
  e: Elsewhere,
  change: Change,
): Promise<OwnChange | null> => {
  const sender = getConversationSender();
  const person = input.readerUserId ?? input.askerUserId ?? null;
  if (!sender || !person) return null;
  const mine = await sender.isOwn({
    agentId: input.agentId,
    readerUserId: person,
    recipientRef: e.recipientRef,
    messageId: input.messageId,
  });
  if (!mine) return null;
  const base = {
    agentId: input.agentId,
    readerUserId: input.readerUserId ?? null,
    askerUserId: input.askerUserId ?? null,
    conversation: e.label,
    conversationRef: e.recipientRef,
    messageId: input.messageId,
    originConversationId: input.conversationId,
    originTurnId: input.turnId,
  };
  return {
    via: "you",
    outcome:
      change.op === "edit"
        ? await sender.edit({ ...base, text: change.text })
        : await sender.delete(base),
  };
};

/** Route an id elsewhere: the person's own send goes through the act-as-you
 * seam; anything else must be one of the agent's own posts there that this
 * caller may reach (`agentAccessOf`). Answers the address to change it
 * through. */
const changeElsewhere = async (
  input: Caller & { conversation: string; messageId: string },
  change: Change,
  now: number,
): Promise<OwnChange | (Resolved & { conversationRef: string })> => {
  const e = await resolveElsewhere(input);
  const asYou = await changeAsYou(input, e, change);
  if (asYou) return asYou;
  if (e.refusal) throw new ServiceError("UNPROCESSABLE", e.refusal);
  const since = now - WINDOW_MS;
  if (e.access.kind === "schedule") {
    const [sent] = await ledgerPosts(e, since, {
      originConversationId: e.access.conversationId,
      messageRef: input.messageId,
    });
    if (!sent) {
      throw new ServiceError(
        "UNPROCESSABLE",
        `That isn't one of your own messages this schedule sent to ${e.label} in the last 24 hours. Nothing was changed. ${STOP}`,
      );
    }
  }
  const own = await call(e.r, () =>
    e.r.facet.findAnywhere({
      ...e.r.target,
      messageId: input.messageId,
      since,
    }),
  );
  if (!own) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `That isn't one of your own messages from the last 24 hours in ${e.label}. Use list_my_replies with conversation to find the right messageId. Nothing was changed.`,
    );
  }
  return { ...e.r, conversationRef: e.recipientRef };
};

const NOT_YOURS =
  "That isn't one of your own replies from the last 24 hours in this conversation. Use list_my_replies to find the right messageId. Nothing was changed.";

/** The address to change a message through: elsewhere (routed, maybe as
 * the person), or the calling conversation, re-checked against ITS own
 * replies before acting (an id from elsewhere, someone else's message, a
 * card, or an old reply is refused before the provider is asked). */
const changeTarget = async (
  input: Caller & { messageId: string },
  change: Change,
): Promise<OwnChange | (Resolved & { conversationRef: string | null })> => {
  const now = input.now ?? Date.now();
  if (input.conversation) {
    return changeElsewhere(
      { ...input, conversation: input.conversation },
      change,
      now,
    );
  }
  const r = await resolve(input.agentId, input.conversationId, input.turnId);
  const reply = await call(r, () =>
    r.facet.find({
      ...r.target,
      messageId: input.messageId,
      since: now - WINDOW_MS,
    }),
  );
  if (!reply) throw new ServiceError("UNPROCESSABLE", NOT_YOURS);
  return { ...r, conversationRef: null };
};

const isChange = (x: OwnChange | Resolved): x is OwnChange => "via" in x;

export const editOwnReply = async (
  input: Caller & { messageId: string; text: string },
): Promise<OwnChange> => {
  const routed = await changeTarget(input, { op: "edit", text: input.text });
  if (isChange(routed)) return routed;
  // The answer path's mention rule: `@[Name]` pings only a person the
  // platform resolved (a linked teammate, or this conversation's anchor
  // when it is the conversation being changed).
  const mentions = new Map<string, string>();
  const names = mentionNamesOf(input.text);
  if (names.length > 0) {
    for (const m of await resolveMentionNames(
      routed.presenceId,
      names,
      input.conversation ? undefined : (input.conversationId ?? undefined),
    )) {
      if (m.kind === "resolved") mentions.set(m.name, m.externalUserId);
    }
  }
  await call(routed, () =>
    routed.facet.edit({
      ...routed.target,
      messageId: input.messageId,
      text: input.text,
      mentions,
    }),
  );
  return {
    via: "agent",
    presenceId: routed.presenceId,
    conversationRef: routed.conversationRef,
  };
};

export const deleteOwnReply = async (
  input: Caller & { messageId: string },
): Promise<OwnChange> => {
  const routed = await changeTarget(input, { op: "delete" });
  if (isChange(routed)) return routed;
  await call(routed, () =>
    routed.facet.remove({ ...routed.target, messageId: input.messageId }),
  );
  return {
    via: "agent",
    presenceId: routed.presenceId,
    conversationRef: routed.conversationRef,
  };
};
