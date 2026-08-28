import { apiGet, apiPost, apiPut } from "./client";
import type {
  AbortTurnResult,
  Conversation,
  SendMessageOutcome,
  TranscriptPage,
  Turn,
} from "./types";

/**
 * The conversation plane's read/write surface (plan step 4).
 *
 * Streaming is deliberately NOT here: `GET /:id/stream` is Server-Sent Events,
 * which `apiGet` cannot model — it returns a parsed body, and the whole point
 * of that endpoint is that it never ends. The stream is consumed by
 * `use-conversation-stream`, which owns its own EventSource-shaped fetch —
 * building its url with `conversationPath` below.
 */

/**
 * Every conversation path goes through here so the id is percent-encoded
 * exactly once, always. Ids normally come from our own API, but the thread
 * route's id arrives DECODED from the URL (`useParams`) — without encoding,
 * a crafted link (`..%2F<segment>`) would URL-normalize the request onto a
 * different `/v1` path under the caller's credentials.
 */
export const conversationPath = (conversationId: string, sub = "") =>
  `/v1/conversations/${encodeURIComponent(conversationId)}${sub}`;

/**
 * The §3.18 door: materialize (or fetch) the agent's one direct conversation.
 * Idempotent PUT — safe to call on every thread mount; the server's partial
 * unique index guarantees every caller gets the same row. The id is encoded
 * for the same reason as `conversationPath`: it can arrive from a URL.
 */
export const ensureDirect = (agentId: string) =>
  apiPut<Conversation>(
    `/v1/agents/${encodeURIComponent(agentId)}/conversations/direct`,
    {},
  );

export const turns = (conversationId: string) =>
  apiGet<{ turns: Turn[] }>(conversationPath(conversationId, "/turns")).then(
    (r) => r.turns,
  );

/**
 * Say something whatever the agent is doing: a free conversation gets an
 * ordinary turn, a busy one accepts the message as a mid-run follow-up that
 * steers into the live run (or runs next). Never a 409 for "busy" — the one
 * refusal left is the follow-up cap. (The strict `POST /turns` endpoint
 * still exists server-side for API users who want the one-at-a-time 409;
 * the web has no consumer for it.) `attachmentIds` are previously-uploaded
 * pending attachments to bind to this message.
 */
export const sendMessage = (
  conversationId: string,
  message: string,
  attachmentIds?: string[],
) =>
  apiPost<SendMessageOutcome>(conversationPath(conversationId, "/messages"), {
    message,
    ...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {}),
  });

export const abortTurn = (turnId: string) =>
  apiPost<AbortTurnResult>(`/v1/turns/${encodeURIComponent(turnId)}/abort`, {});

/**
 * One page of the durable transcript. `since` is the highest `seq` already
 * held — a cursor, never an offset — so paging is stable while new events
 * arrive behind it.
 *
 * The LIVE surface doesn't call this (the stream replays history before
 * tailing); it models the server's REST transcript reader for consumers that
 * want pages rather than a connection.
 */
export const events = (
  conversationId: string,
  options: { since?: number; limit?: number } = {},
) => {
  const query = new URLSearchParams();
  if (options.since !== undefined) query.set("since", String(options.since));
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  const suffix = query.toString() ? `?${query}` : "";
  return apiGet<TranscriptPage>(
    conversationPath(conversationId, `/events${suffix}`),
  );
};

/**
 * Walk the transcript to its end.
 *
 * The reader needs the WHOLE history, and one page is 500 events — a turn with
 * a busy tool run exceeds that on its own. Bounded so a pathological
 * conversation cannot spin the browser; the caller shows what it got.
 */
const MAX_HISTORY_PAGES = 100;

export const allEvents = async (
  conversationId: string,
): Promise<TranscriptPage> => {
  let since: number | undefined;
  const collected: TranscriptPage["events"] = [];

  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const chunk = await events(conversationId, { since });
    collected.push(...chunk.events);
    if (!chunk.hasMore) {
      return { events: collected, nextSince: chunk.nextSince, hasMore: false };
    }
    since = chunk.nextSince;
  }

  return { events: collected, nextSince: since ?? 0, hasMore: true };
};
