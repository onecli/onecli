import { db } from "@onecli/db";
import { conversationsHistory, usersInfo } from "@onecli/channels/slack";
import { getCrypto } from "../../../../providers";
import { parseSlackPresenceCredentials } from "./types";

/**
 * A channel's recent conversation as readable lines ("Dana: can someone
 * check the deploy?"), oldest first: what the reply judge reads to decide.
 * Read live from Slack, so it includes what the agent itself never took a
 * turn on. Speakers and `<@U…>` tags resolve to real names: a linked
 * teammate's OneCLI name, else the (cached) Slack display name - without
 * names, "Sam, ..." cannot read as addressed to someone else.
 */

/** Slack names for people with no linked account, cached across events.
 * Bounded: past the cap, the oldest entry goes. */
const NAME_TTL_MS = 60 * 60 * 1000;
const NAME_CACHE_MAX = 5_000;
const NAME_PROBE_MS = 700;
const nameCache = new Map<string, { name: string; at: number }>();

/** A rendered line's longest text: a verdict needs the gist. */
const LINE_MAX = 400;

/** One printable line, clamped: message text and display names are
 * user-controlled, so no control character may open a new line. */
export const cleanLine = (raw: string, max: number): string =>
  [...raw]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? " " : ch;
    })
    .join("")
    .trim()
    .slice(0, max);

const resolveNames = async (
  integrationId: string,
  botToken: string,
  ids: string[],
): Promise<Map<string, string>> => {
  const names = new Map<string, string>();
  const links = await db.channelUserLink.findMany({
    where: { integrationId, externalUserId: { in: ids } },
    select: { externalUserId: true, user: { select: { name: true } } },
  });
  for (const link of links) {
    if (link.user.name) names.set(link.externalUserId, link.user.name);
  }
  const now = Date.now();
  const missing = ids.filter((id) => {
    if (names.has(id)) return false;
    const hit = nameCache.get(`${integrationId}:${id}`);
    if (hit && now - hit.at < NAME_TTL_MS) {
      names.set(id, hit.name);
      return false;
    }
    return true;
  });
  await Promise.all(
    missing.map(async (id) => {
      let timer: NodeJS.Timeout | undefined;
      const info = await Promise.race([
        usersInfo(botToken, id).catch(() => null),
        new Promise<null>((r) => {
          timer = setTimeout(() => r(null), NAME_PROBE_MS);
        }),
      ]);
      clearTimeout(timer);
      const name =
        info?.user.profile?.display_name ||
        info?.user.profile?.real_name ||
        info?.user.name;
      if (!name) return;
      names.set(id, name);
      const cacheKey = `${integrationId}:${id}`;
      nameCache.delete(cacheKey);
      nameCache.set(cacheKey, { name, at: now });
      if (nameCache.size > NAME_CACHE_MAX) {
        const oldest = nameCache.keys().next().value;
        if (oldest !== undefined) nameCache.delete(oldest);
      }
    }),
  );
  return names;
};

const TAG = /<@([A-Z0-9]+)>/g;

export interface RoomTranscript {
  /** Readable lines, oldest first. */
  lines: string[];
  /** Renders one more message (the new one) the same way. */
  render: (speaker: string | undefined, text: string) => string;
  /** Who replied in a top-level message's thread, by message ts. */
  repliersOf: (ts: string) => string[];
}

/**
 * The last `limit` top-level messages of `channel` as seen by `presenceId`'s
 * bot (`excludeTs` drops the message being judged - it is rendered last by
 * the caller). Null when the presence has no bot token.
 */
export const readRoomTranscript = async (input: {
  presenceId: string;
  channel: string;
  limit: number;
  excludeTs?: string;
  /** Extra user ids the caller will render (the new message's speaker). */
  alsoName?: string[];
}): Promise<RoomTranscript | null> => {
  const presence = await db.agentChannel.findUnique({
    where: { id: input.presenceId },
    select: {
      integrationId: true,
      identityRef: true,
      externalId: true,
      credentials: true,
      agent: { select: { name: true } },
    },
  });
  if (!presence?.credentials) return null;
  const { botToken } = parseSlackPresenceCredentials(
    await getCrypto().decrypt(presence.credentials),
  );
  if (!botToken) return null;

  const history = await conversationsHistory(botToken, {
    channel: input.channel,
    limit: input.limit,
  });
  const self = presence.identityRef;
  const messages = history.messages.filter(
    (m) => m.ts !== input.excludeTs && m.text,
  );
  const ids = [
    ...new Set(
      [
        ...(input.alsoName ?? []),
        ...messages.map((m) => m.user ?? ""),
        ...messages.flatMap((m) =>
          [...(m.text ?? "").matchAll(TAG)].map((match) => match[1] ?? ""),
        ),
      ].filter((id) => id !== "" && id !== self),
    ),
  ];
  const names = await resolveNames(presence.integrationId, botToken, ids);
  const nameOf = (id: string) =>
    id === self
      ? presence.agent.name
      : cleanLine(names.get(id) ?? `user ${id}`, 60);
  const render = (speaker: string | undefined, text: string) =>
    `${speaker ? nameOf(speaker) : "an app"}: ${cleanLine(
      text.replace(TAG, (_, id: string) => `@${nameOf(id)}`),
      LINE_MAX,
    )}`;
  // How the room answered each message, visible inline: the judge reads
  // the room's natural rhythm (who threads, who talks in the channel)
  // the way a person scrolling the channel would.
  const threadNote = (m: (typeof messages)[number]) => {
    const count = m.reply_count ?? 0;
    if (count === 0) return "";
    const withAgent = self !== null && (m.reply_users ?? []).includes(self);
    return ` [thread: ${count} ${count === 1 ? "reply" : "replies"}${
      withAgent ? `, incl. ${presence.agent.name}` : ""
    }]`;
  };
  return {
    lines: [...messages].reverse().map(
      (m) =>
        render(
          // The agent's own posts carry its APP id, not a user id.
          m.app_id && m.app_id === presence.externalId
            ? (self ?? "?")
            : (m.user ?? (m.bot_id ? undefined : "?")),
          m.text ?? "",
        ) + threadNote(m),
    ),
    render,
    repliersOf: (ts) =>
      history.messages.find((m) => m.ts === ts)?.reply_users ?? [],
  };
};
