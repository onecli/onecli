/**
 * The Slack ADDRESS CODEC — the one place the `<channel>:<threadRootTs>`
 * packing is encoded and decoded.
 *
 * A THREAD's platform address packs both halves into one opaque string
 * (`externalThreadId` on links, conversations, and reach rows), whether the
 * thread sits in a channel or inside a DM; a DM's TOP LEVEL is the bare IM
 * channel id. Before this file the codec was split across three files in
 * two runtimes — the encoder in the api's interpret.ts, the full decoder in
 * the adapter's targets.ts, and a half-decoder (channel-only) in the api's
 * reach facet — which is exactly how one side changes the format and the
 * other keeps parsing yesterday's.
 */

/** The group-thread address (the step-6 decision): the THREAD, not the
 * channel — parallel threads get parallel contexts. A top-level trigger
 * starts a thread rooted at itself. */
export const groupThreadId = (channel: string, threadRootTs: string): string =>
  `${channel}:${threadRootTs}`;

/**
 * A thread opened INSIDE a DM: the same packing as a group thread, over the
 * IM channel. The DM's top level keeps the bare IM id (the person's one
 * direct conversation, shared with the web); each thread under it is its
 * own conversation, addressed by this. The link stays `direct` — the reply
 * still goes to the IM, narrowed to the thread — so the decoder below
 * reads the packing for both kinds.
 */
export const directThreadId = (
  imChannel: string,
  threadRootTs: string,
): string => `${imChannel}:${threadRootTs}`;

/** Where a link's posts go, from its address ALONE: one packing for both
 * link kinds — a bare channel id (a DM's top level) addresses the channel,
 * a packed `<channel>:<ts>` addresses that thread. An id with no separator
 * degrades to channel-only (top-level post) rather than throwing — a
 * malformed stored address must never take down the completion pass. */
export const unpackThreadAddress = (
  externalThreadId: string,
): { channel: string; threadTs: string | null } => {
  const separator = externalThreadId.indexOf(":");
  if (separator === -1) return { channel: externalThreadId, threadTs: null };
  return {
    channel: externalThreadId.slice(0, separator),
    threadTs: externalThreadId.slice(separator + 1),
  };
};

/** The SPACE behind a group-thread address (the reach ledger's channel
 * key) — the codec's channel half, tolerant of a bare channel id. */
export const spaceOfThreadAddress = (externalThreadId: string): string =>
  externalThreadId.split(":")[0] ?? "";

/**
 * A posted MESSAGE's durable ref (`<channel>:<ts>`) — same packing as the
 * thread address, different meaning: this names one message (a card the
 * settle pass rewrites), not a conversation. The control plane stores it
 * opaquely (`externalMessageRef`); only this codec reads or writes the
 * format.
 */
export const packMessageRef = (channel: string, ts: string): string =>
  `${channel}:${ts}`;

/** Null when the ref is absent or malformed — a recovered prompt with no
 * usable ref degrades to the thread address, never throws. */
export const unpackMessageRef = (
  ref: string | null | undefined,
): { channel: string; ts: string } | null => {
  if (!ref) return null;
  const separator = ref.indexOf(":");
  if (separator <= 0) return null;
  return { channel: ref.slice(0, separator), ts: ref.slice(separator + 1) };
};
