import { db } from "@onecli/db";
import { ChannelProviderApiError, mentionNamesOf } from "@onecli/channels";
import { getCrypto } from "../../providers";
import { ServiceError } from "../errors";
import { channelProvider, isChannelProviderId } from "./registry";
import type { ChannelProvider, OwnReplyTarget } from "./types";
import { noteOutboundFailure } from "./agent-channel-service";
import { decodeInboundText } from "./channel-ingestion-service";
import { resolveMentionNames } from "./mention-resolution-service";

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
const call = async <T>(r: Resolved, op: () => Promise<T>): Promise<T> => {
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

const NOT_YOURS =
  "That isn't one of your own replies from the last 24 hours in this conversation. Use list_my_replies to find the right messageId. Nothing was changed.";

/** Re-checks the id against THIS conversation's own replies before acting:
 * an id from elsewhere, someone else's message, a card, or an old reply is
 * refused here, before the provider is asked to change anything. */
const requireOwn = async (
  r: Resolved,
  messageId: string,
  now: number,
): Promise<void> => {
  const reply = await call(r, () =>
    r.facet.find({ ...r.target, messageId, since: now - WINDOW_MS }),
  );
  if (!reply) throw new ServiceError("UNPROCESSABLE", NOT_YOURS);
};

/** The agent's own replies in this conversation, newest first. */
export const listOwnReplies = async (input: {
  agentId: string;
  conversationId: string | null;
  turnId: string | null;
  now?: number;
}): Promise<OwnReplyView[]> => {
  const r = await resolve(input.agentId, input.conversationId, input.turnId);
  const since = (input.now ?? Date.now()) - WINDOW_MS;
  const replies = await call(r, () =>
    r.facet.list({ ...r.target, since, limit: LIST_LIMIT }),
  );
  return Promise.all(
    replies.map(async (reply) => {
      const text = await r.decode(reply.text);
      return {
        messageId: reply.messageId,
        text:
          text.length > MAX_LISTED_CHARS
            ? `${text.slice(0, MAX_LISTED_CHARS)}… [truncated]`
            : text,
        sentAt: new Date(reply.sentAt).toISOString(),
      };
    }),
  );
};

export const editOwnReply = async (input: {
  agentId: string;
  conversationId: string | null;
  turnId: string | null;
  messageId: string;
  text: string;
  now?: number;
}): Promise<{ presenceId: string }> => {
  const r = await resolve(input.agentId, input.conversationId, input.turnId);
  await requireOwn(r, input.messageId, input.now ?? Date.now());
  // The answer path's mention rule: `@[Name]` pings only a person the
  // platform resolved (a linked teammate or this conversation's anchor).
  const mentions = new Map<string, string>();
  const names = mentionNamesOf(input.text);
  if (names.length > 0) {
    for (const m of await resolveMentionNames(
      r.presenceId,
      names,
      input.conversationId ?? undefined,
    )) {
      if (m.kind === "resolved") mentions.set(m.name, m.externalUserId);
    }
  }
  await call(r, () =>
    r.facet.edit({
      ...r.target,
      messageId: input.messageId,
      text: input.text,
      mentions,
    }),
  );
  return { presenceId: r.presenceId };
};

export const deleteOwnReply = async (input: {
  agentId: string;
  conversationId: string | null;
  turnId: string | null;
  messageId: string;
  now?: number;
}): Promise<{ presenceId: string }> => {
  const r = await resolve(input.agentId, input.conversationId, input.turnId);
  await requireOwn(r, input.messageId, input.now ?? Date.now());
  await call(r, () =>
    r.facet.remove({ ...r.target, messageId: input.messageId }),
  );
  return { presenceId: r.presenceId };
};
